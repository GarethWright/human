/**
 * MoveNet model implementation
 *
 * Based on: [**MoveNet**](https://blog.tensorflow.org/2021/05/next-generation-pose-detection-with-movenet-and-tensorflowjs.html)
 */

import { log, join } from '../util/util';
import * as box from '../util/box';
import * as tf from '../../dist/tfjs.esm.js';
import * as coords from './movenetcoords';
import type { BodyKeypoint, BodyResult, Box, Point } from '../result';
import type { GraphModel, Tensor } from '../tfjs/types';
import type { Config } from '../config';
import { fakeOps } from '../tfjs/backend';
import { env } from '../util/env';

let model: GraphModel | null;
let inputSize = 0;
const boxExpandFact = 1.5; // increase to 150%

const cache: {
  boxes: Array<Box>,
  bodies: Array<BodyResult>;
} = {
  boxes: [],
  bodies: [],
};

let skipped = Number.MAX_SAFE_INTEGER;
const keypoints: Array<BodyKeypoint> = [];

export async function load(config: Config): Promise<GraphModel> {
  if (env.initial) model = null;
  if (!model) {
    fakeOps(['size'], config);
    model = await tf.loadGraphModel(join(config.modelBasePath, config.body.modelPath || '')) as unknown as GraphModel;
    if (!model || !model['modelUrl']) log('load model failed:', config.body.modelPath);
    else if (config.debug) log('load model:', model['modelUrl']);
  } else if (config.debug) log('cached model:', model['modelUrl']);
  inputSize = model.inputs[0].shape ? model.inputs[0].shape[2] : 0;
  if (inputSize === -1) inputSize = 256;
  return model;
}

async function parseSinglePose(res, config, image, inputBox) {
  const kpt = res[0][0];
  keypoints.length = 0;
  let score = 0;
  for (let id = 0; id < kpt.length; id++) {
    score = kpt[id][2];
    if (score > config.body.minConfidence) {
      const positionRaw: Point = [
        (inputBox[3] - inputBox[1]) * kpt[id][1] + inputBox[1],
        (inputBox[2] - inputBox[0]) * kpt[id][0] + inputBox[0],
      ];
      keypoints.push({
        score: Math.round(100 * score) / 100,
        part: coords.kpt[id],
        positionRaw,
        position: [ // normalized to input image size
          Math.round((image.shape[2] || 0) * positionRaw[0]),
          Math.round((image.shape[1] || 0) * positionRaw[1]),
        ],
      });
    }
  }
  score = keypoints.reduce((prev, curr) => (curr.score > prev ? curr.score : prev), 0);
  const bodies: Array<BodyResult> = [];
  const newBox = box.calc(keypoints.map((pt) => pt.position), [image.shape[2], image.shape[1]]);
  const annotations: Record<string, Point[][]> = {};
  for (const [name, indexes] of Object.entries(coords.connected)) {
    const pt: Array<Point[]> = [];
    for (let i = 0; i < indexes.length - 1; i++) {
      const pt0 = keypoints.find((kp) => kp.part === indexes[i]);
      const pt1 = keypoints.find((kp) => kp.part === indexes[i + 1]);
      if (pt0 && pt1 && pt0.score > (config.body.minConfidence || 0) && pt1.score > (config.body.minConfidence || 0)) pt.push([pt0.position, pt1.position]);
    }
    annotations[name] = pt;
  }
  bodies.push({ id: 0, score, box: newBox.box, boxRaw: newBox.boxRaw, keypoints, annotations });
  return bodies;
}

async function parseMultiPose(res, config, image, inputBox) {
  const bodies: Array<BodyResult> = [];
  for (let id = 0; id < res[0].length; id++) {
    const kpt = res[0][id];
    const totalScore = Math.round(100 * kpt[51 + 4]) / 100;
    if (totalScore > config.body.minConfidence) {
      keypoints.length = 0;
      for (let i = 0; i < 17; i++) {
        const score = kpt[3 * i + 2];
        if (score > config.body.minConfidence) {
          const positionRaw: Point = [
            (inputBox[3] - inputBox[1]) * kpt[3 * i + 1] + inputBox[1],
            (inputBox[2] - inputBox[0]) * kpt[3 * i + 0] + inputBox[0],
          ];
          keypoints.push({
            part: coords.kpt[i],
            score: Math.round(100 * score) / 100,
            positionRaw,
            position: [Math.round((image.shape[2] || 0) * positionRaw[0]), Math.round((image.shape[1] || 0) * positionRaw[1])],
          });
        }
      }
      const newBox = box.calc(keypoints.map((pt) => pt.position), [image.shape[2], image.shape[1]]);
      // movenet-multipose has built-in box details
      // const boxRaw: Box = [kpt[51 + 1], kpt[51 + 0], kpt[51 + 3] - kpt[51 + 1], kpt[51 + 2] - kpt[51 + 0]];
      // const box: Box = [Math.trunc(boxRaw[0] * (image.shape[2] || 0)), Math.trunc(boxRaw[1] * (image.shape[1] || 0)), Math.trunc(boxRaw[2] * (image.shape[2] || 0)), Math.trunc(boxRaw[3] * (image.shape[1] || 0))];
      const annotations: Record<string, Point[][]> = {};
      for (const [name, indexes] of Object.entries(coords.connected)) {
        const pt: Array<Point[]> = [];
        for (let i = 0; i < indexes.length - 1; i++) {
          const pt0 = keypoints.find((kp) => kp.part === indexes[i]);
          const pt1 = keypoints.find((kp) => kp.part === indexes[i + 1]);
          if (pt0 && pt1 && pt0.score > (config.body.minConfidence || 0) && pt1.score > (config.body.minConfidence || 0)) pt.push([pt0.position, pt1.position]);
        }
        annotations[name] = pt;
      }
      bodies.push({ id, score: totalScore, box: newBox.box, boxRaw: newBox.boxRaw, keypoints: [...keypoints], annotations });
    }
  }
  bodies.sort((a, b) => b.score - a.score);
  if (bodies.length > config.body.maxDetected) bodies.length = config.body.maxDetected;
  return bodies;
}

export async function predict(input: Tensor, config: Config): Promise<BodyResult[]> {
  if (!model || !model?.inputs[0].shape) return []; // something is wrong with the model
  if (!config.skipFrame) cache.boxes.length = 0; // allowed to use cache or not
  skipped++; // increment skip frames
  if (config.skipFrame && (skipped <= (config.body.skipFrames || 0))) {
    return cache.bodies; // return cached results without running anything
  }
  return new Promise(async (resolve) => {
    const t: Record<string, Tensor> = {};
    skipped = 0;
    cache.bodies = []; // reset bodies result
    if (cache.boxes.length >= (config.body.maxDetected || 0)) { // if we have enough cached boxes run detection using cache
      for (let i = 0; i < cache.boxes.length; i++) { // run detection based on cached boxes
        t.crop = tf.image.cropAndResize(input, [cache.boxes[i]], [0], [inputSize, inputSize], 'bilinear');
        t.cast = tf.cast(t.crop, 'int32');
        t.res = await model?.predict(t.cast) as Tensor;
        const res = await t.res.array();
        const newBodies = (t.res.shape[2] === 17) ? await parseSinglePose(res, config, input, cache.boxes[i]) : await parseMultiPose(res, config, input, cache.boxes[i]);
        cache.bodies = cache.bodies.concat(newBodies);
        Object.keys(t).forEach((tensor) => tf.dispose(t[tensor]));
      }
    }
    if (cache.bodies.length !== config.body.maxDetected) { // did not find enough bodies based on cached boxes so run detection on full frame
      t.resized = tf.image.resizeBilinear(input, [inputSize, inputSize], false);
      t.cast = tf.cast(t.resized, 'int32');
      t.res = await model?.predict(t.cast) as Tensor;
      const res = await t.res.array();
      cache.bodies = (t.res.shape[2] === 17) ? await parseSinglePose(res, config, input, [0, 0, 1, 1]) : await parseMultiPose(res, config, input, [0, 0, 1, 1]);
      // cache.bodies = cache.bodies.map((body) => ({ ...body, box: box.scale(body.box, 0.5) }));
      Object.keys(t).forEach((tensor) => tf.dispose(t[tensor]));
    }
    cache.boxes.length = 0; // reset cache
    for (let i = 0; i < cache.bodies.length; i++) {
      if (cache.bodies[i].keypoints.length > (coords.kpt.length / 2)) { // only update cache if we detected at least half keypoints
        const scaledBox = box.scale(cache.bodies[i].boxRaw, boxExpandFact);
        const cropBox = box.crop(scaledBox);
        cache.boxes.push(cropBox);
      }
    }
    resolve(cache.bodies);
  });
}
