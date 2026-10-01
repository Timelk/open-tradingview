import type {BridgeError,BridgeErrorCode} from './protocol';
import {AgentInputError} from './anchors';

export class AgentBridgeError extends Error {
  readonly code:BridgeErrorCode;
  constructor(code:BridgeErrorCode,message:string){super(message);this.code=code;}
}
/** Scene/model validation throws plain errors with user-facing text; those
 * reach the agent as BAD_REQUEST so it can correct the call. */
export function toBridgeError(error:unknown):BridgeError {
  if(error instanceof AgentBridgeError)return {code:error.code,message:error.message};
  if(error instanceof AgentInputError)return {code:'BAD_REQUEST',message:error.message};
  return {code:'FAILED',message:error instanceof Error?error.message:String(error)};
}
