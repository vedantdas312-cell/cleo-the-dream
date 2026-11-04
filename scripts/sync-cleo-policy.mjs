import {readFile,writeFile} from 'node:fs/promises';
import {cleoSharedPolicy} from '../src/cleo-shared-policy.mjs';
const path='config/cleo-instructions.md';
const start='<!-- shared-policy:start -->', end='<!-- shared-policy:end -->';
const current=await readFile(path,'utf8');
const block=`${start}\n${cleoSharedPolicy}\n${end}`;
const next=current.includes(start) ? current.replace(/<!-- shared-policy:start -->[\s\S]*?<!-- shared-policy:end -->/,block) : block+'\n\n'+current;
await writeFile(path,next);
