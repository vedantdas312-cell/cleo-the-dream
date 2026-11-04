export type RealtimeTurnContext = {turnId:string;turnGeneration:number};
export class RealtimeTurnState {
  constructor(options?:{createVoiceTurnId?:(generation:number)=>string});
  current():RealtimeTurnContext;
  beginVoice(itemId?:string):{accepted:boolean;context:RealtimeTurnContext|null};
  endSpeech():void;
  resolveInput(itemId:string):RealtimeTurnContext;
  completeInput(itemId:string):{context:RealtimeTurnContext;invalid:boolean;duplicate?:boolean};
  commit(context:RealtimeTurnContext|null):boolean;
  isStale(context:RealtimeTurnContext):boolean;
  close():void;
}
