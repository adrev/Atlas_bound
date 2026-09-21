import { parentPort, workerData } from 'node:worker_threads';
import { generateChronicle, type ChroniclerInput } from './Chronicler.js';

if (!parentPort) throw new Error('ChronicleVertexWorker must run in a worker thread');
parentPort.postMessage(await generateChronicle(workerData as ChroniclerInput));
