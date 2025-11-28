import {Job} from "../models/Job";
import ProcessorInterface from "./processorInterface";

class UploadProcessor implements ProcessorInterface {
  async run(job: Job) {
    // upload images to s3
    // return payload with imageUrls and info
  }
}

export default UploadProcessor;
