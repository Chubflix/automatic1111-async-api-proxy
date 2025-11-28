import {Job} from "../models/Job";
import ProcessorInterface from "./processorInterface";

class UploadProcessor implements ProcessorInterface {
  async run(job: Job) {
    // For now, uploading is a no-op placeholder. We keep images inline (base64)
    // and simply pass through the result so the workflow can proceed.
    return job.result || {};
  }
}

export default UploadProcessor;
