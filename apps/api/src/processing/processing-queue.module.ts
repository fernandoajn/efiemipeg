import { Module } from "@nestjs/common";
import { ProcessingQueue } from "./processing-queue.service";

@Module({ providers: [ProcessingQueue], exports: [ProcessingQueue] })
export class ProcessingQueueModule {}
