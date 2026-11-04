import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile,spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import {createDraftDocx} from '../src/draft-docx.ts';
import {redlineDocx,inspectDocx} from '../src/docx.ts';
import {createReviewPdf} from '../src/review-pdf.ts';

test('PDF preview keeps numbered additions on separate visible lines', {skip:!!spawnSync('pdftotext',['-v']).error}, async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cleo-lines-'));
  try {
    const source=await createDraftDocx({title:'Synthetic exhibit',blocks:[{kind:'paragraph',text:'Payment is monthly.'}]});
    const inspected=await inspectDocx(source.bytes);
    const p=inspected.paragraphs.find(p=>p.text==='Payment is monthly.')!;
    const result=await redlineDocx(source.bytes,{sourceSha256:inspected.sourceSha256,changes:[{
      paragraphId:p.id,original:p.text,replacement:p.text+'\n\nA.1 Reserved idea: [DESCRIBE].\n\nA.2 Equity: [AGREE].\n\nA.3 Trigger: [AGREE].',reason:'Separate proposed terms.'
    }]});
    const path=join(dir,'preview.pdf');await writeFile(path,await createReviewPdf(result.bytes));
    const {stdout}=await promisify(execFile)('pdftotext',['-layout',path,'-']);
    for(const section of ['A.1','A.2','A.3']) assert.match(stdout,new RegExp('(?:^|\\n)\\s*'+section.replace('.','\\.')+' '));
  } finally {await rm(dir,{recursive:true,force:true});}
});
