import ProcessorInterface from "./processorInterface";
import {Job} from "../models/Job";

class WebhookProcessor implements ProcessorInterface {
  async run(job: Job) {
    // send webhook to a1111 with payload from job
    // return empty payload
    return {}
  }
}

export default WebhookProcessor;