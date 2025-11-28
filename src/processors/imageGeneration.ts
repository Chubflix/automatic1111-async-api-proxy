import {Job} from "../models/Job";
import ProcessorInterface from "./processorInterface";

const createLogger = require('../libs/logger');
const log = createLogger('proc:generate');

class ImageGenerationProcessor implements ProcessorInterface {
  async run(job: Job) {
    // generate new seed
    // generate image with a1111
    // check progress in a1111 and update progress of job
    // return payload with images (base64), seed and info
  }
}

export default ImageGenerationProcessor;
