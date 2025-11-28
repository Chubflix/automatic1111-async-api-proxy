import ProcessorInterface from "./processorInterface";
import {Job} from "../models/Job";

class NoopProcessor implements ProcessorInterface {
  async run(job: Job) {
    return job.result
  }
}

export default NoopProcessor;