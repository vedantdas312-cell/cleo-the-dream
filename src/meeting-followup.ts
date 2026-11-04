// Only bounded, read-only conversation can skip model-based routing. Explicitly
// naming Cleo supplies addressing; anything beyond ordinary dialogue still needs
// contextual interpretation before it can change a permission or private lane.
export function directMeetingConversation(text:string):'greet'|'speak'|undefined {
  if(text.length>600||/[\r\n]/.test(text))return;
  const value=text.normalize('NFKC').toLowerCase().trim().replace(/[?.!]+$/,'').trim().replace(/\s+/g,' ');
  const prefix=/^(?:(?:hi|hello|hey)\s+)?cleo(?:\s*[,:-]\s*|\s+)/.exec(value);
  const suffix=/\s*,?\s*cleo$/.exec(value);
  if(!prefix&&!suffix)return;
  const request=(prefix?value.slice(prefix[0].length):value.slice(0,suffix!.index)).trim();
  if(!request)return 'greet';
  if(/^(?:hi|hello|hey|good (?:morning|afternoon|evening)|how are you(?: doing)?)$/.test(request))return 'greet';
  // Match complete read-only forms rather than treating any question prefix
  // as safe. A denylist misses proposals such as "what wording would you suggest"
  // and combined requests such as "explain this clause and draft a replacement".
  const reference='(?:(?:this|that|the|our|your)(?: (?:saved|current|proposed))? |(?:saved|current|proposed) )?(?:(?:payment|notice|liability|confidentiality|termination|renewal|indemnity|governing law|dispute resolution) )?(?:clause|paragraph|passage|change|redline|wording|provision|document|draft|agreement|contract|section|term|terms)';
  const subject=`(?:this|that|it|${reference})`;
  const explanation=new RegExp(`^(?:(?:can|could|would) you (?:please )?)?(?:please )?(?:explain|describe|clarify|tell (?:me|us) about|help (?:me|us) understand) ${subject}(?: (?:more simply|in (?:plain english|simple terms)))?$`);
  const question=new RegExp(`^(?:what (?:does|do) ${subject} (?:mean|say|cover|require)|why is ${subject} important|how does ${subject} (?:work|help|affect (?:me|us))|what (?:is|are) (?:the )?(?:risk|risks|practical effect|purpose) (?:of|in|with) ${subject})$`);
  if(explanation.test(request)||question.test(request)
    ||/^(?:what do you think|talk (?:to|with) (?:me|us)(?: like (?:a friend|friends))?|let's (?:talk|chat))$/.test(request))return 'speak';
}

// Exact follow-up phrases cannot append navigation, disclosure or a proposal.
export function isSimpleMeetingFollowup(text:string):boolean {
  if(text.length>160)return false;
  const value=text.normalize('NFKC').toLowerCase().trim().replace(/[?.!]$/,'').trim();
  return /^(?:(?:can|could|would) you )?(?:please )?(?:explain (?:that|this)(?: (?:more simply|in (?:simple|simpler|plain) (?:words|terms|english)))?|(?:make|say) (?:that|this) (?:simpler|more simply)|give (?:me|us) (?:an example|a simple example)|repeat (?:that|the last part))(?: please)?$/.test(value)
    || /^(?:and )?(?:what (?:does that mean|do you mean(?: by that)?)|why (?:does that matter|is that important)|how does that (?:help|work))$/.test(value);
}
