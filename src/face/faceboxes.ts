// https://github.com/TropComplique/FaceBoxes-tensorflow

import { log } from '../util/util';
import * as tf from '../../dist/tfjs.esm.js';
import type { GraphModel, Tensor } from '../tfjs/types';
import type { Config } from '../config';

type Box = [number, number, number, number];

export class FaceBoxes {
  enlarge: number;
  model: GraphModel;
  config: Config;
  inputSize: 0;

  constructor(model, config: Config) {
    this.enlarge = 1.1;
    this.model = model;
    this.config = config;
    this.inputSize = model.inputs[0].shape ? model.inputs[0].shape[2] : 0;
  }

  async estimateFaces(input, config) {
    if (config) this.config = config;
    const results: Array<{ confidence: number, box: Box, boxRaw: Box, image: Tensor }> = [];
    const resizeT = tf.image.resizeBilinear(input, [this.inputSize, this.inputSize]);
    const castT = resizeT.toInt();
    const [scoresT, boxesT, numT] = await this.model.executeAsync(castT) as Tensor[];
    const scores = await scoresT.data();
    const squeezeT = tf.squeeze(boxesT);
    const boxes = squeezeT.arraySync();
    scoresT.dispose();
    boxesT.dispose();
    squeezeT.dispose();
    numT.dispose();
    castT.dispose();
    resizeT.dispose();
    for (const i in boxes) {
      if (scores[i] && scores[i] > (this.config.face?.detector?.minConfidence || 0.1)) {
        const crop = [boxes[i][0] / this.enlarge, boxes[i][1] / this.enlarge, boxes[i][2] * this.enlarge, boxes[i][3] * this.enlarge];
        const boxRaw: Box = [crop[1], crop[0], (crop[3]) - (crop[1]), (crop[2]) - (crop[0])];
        const box: Box = [
          parseInt((boxRaw[0] * input.shape[2]).toString()),
          parseInt((boxRaw[1] * input.shape[1]).toString()),
          parseInt((boxRaw[2] * input.shape[2]).toString()),
          parseInt((boxRaw[3] * input.shape[1]).toString())];
        const resized = tf.image.cropAndResize(input, [crop], [0], [this.inputSize, this.inputSize]);
        const image = tf.div(resized, [255]);
        resized.dispose();
        results.push({ confidence: scores[i], box, boxRaw, image });
        // add mesh, meshRaw, annotations,
      }
    }
    return results;
  }
}

export async function load(config) {
  const model = await tf.loadGraphModel(config.face.detector.modelPath);
  if (config.debug) log(`load model: ${config.face.detector.modelPath.match(/\/(.*)\./)[1]}`);
  const faceboxes = new FaceBoxes(model, config);
  if (config.face.mesh.enabled && config.debug) log(`load model: ${config.face.mesh.modelPath.match(/\/(.*)\./)[1]}`);
  if (config.face.iris.enabled && config.debug) log(`load model: ${config.face.iris.modelPath.match(/\/(.*)\./)[1]}`);
  return faceboxes;
}
