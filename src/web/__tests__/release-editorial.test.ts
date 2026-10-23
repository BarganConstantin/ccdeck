import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { groupReleaseNotes, presentReleaseNotes, readNotes, validateReleaseEditorial, RELEASE_NOTES, type ReleaseNote } from '../release-notes';
import ReleaseNotesModal from '../components/ReleaseNotesModal';
const note=(priority?: ReleaseNote['priority'],title='Change'):ReleaseNote=>({title,body:'The behavior changed.',...(priority?{priority}:{})});
const draw=(entries:any[]=[],extra:Record<string,unknown>={})=>renderToStaticMarkup(createElement(ReleaseNotesModal,{entries,since:null,running:'3.46.0',firstRun:false,onClose:()=>{},...extra}));
describe('release editorial contract',()=>{
 it('leaves legacy notes visible rather than guessing highlights',()=>{
  const notes=Array.from({length:7},(_,i)=>note(undefined,`Legacy ${i}`));
  expect(groupReleaseNotes(notes)).toEqual({highlights:[],visible:notes,more:[]});
 });
 it.each([0,1,2,3])('supports %i explicit highlights and retains every note',count=>{
  const notes=[...Array.from({length:count},()=>note('highlight')),note('required','Important'),note()];
  const g=groupReleaseNotes(notes);
  expect(g.highlights).toHaveLength(count);
  expect(g.visible).toContain(notes[count]);
  expect([...g.highlights,...g.visible,...g.more]).toHaveLength(notes.length);
 });
 it('rejects invalid priorities, extra fields, excessive highlights and malformed summaries',()=>{
  for(const source of [
   {'3.46.0':[{...note(),priority:'urgent'}]},
   {'3.46.0':[{...note(),priorty:'highlight'}]},
   {'3.46.0':Array.from({length:4},()=>note('highlight'))},
   {'//summaries':[]},
   {'//summaries':{'3.45.0':'Unknown'}},
   {'3.46.0':[note()],'//summaries':{'3.46.0':3}},
  ]) expect(validateReleaseEditorial(source).length).toBeGreaterThan(0);
 });
 it('keeps technical notices visible even without required priority',()=>{
  const important={...note(undefined,'Configuration'),notice:'Changes settings.json.'};
  const groups=groupReleaseNotes([note('highlight'),important,note()]);
  expect(groups.visible).toContain(important);expect(groups.more).not.toContain(important);
 });
 it('shows only the running release manually and keeps full history external',()=>{
  const entries=[{version:'3.46.0',notes:[note('highlight')]},{version:'3.45.0',notes:[note('required','Required'),note()]}];
  const p=presentReleaseNotes(entries,false,'3.46.0');expect(p.latest).toEqual(entries[0]);expect(p.visiblePrevious).toEqual([]);expect(p.history).toEqual([]);
  const html=draw(entries);expect(html).not.toContain('Previous releases');expect(html).not.toContain('Required');
  expect(html).toContain('Release history');expect(html).toContain('opens in a new tab');expect(html).toContain('https://ccdeck.dev/changelog/');
 });
 it('surfaces required and noticed changes across a skipped upgrade',()=>{
  const entries=[{version:'3.46.0',notes:[note('highlight')]},{version:'3.45.0',notes:[note('required','Required'),{...note(),notice:'Compatible versions only.'},note(undefined,'Optional')]}];
  const p=presentReleaseNotes(entries,true);expect(p.visiblePrevious[0].notes).toHaveLength(2);expect(p.history[0].notes.map(n=>n.title)).toEqual(['Optional']);
 });
 it('keeps a historical highlight with a setup notice visible across later upgrades',()=>{
  const setup={...note('highlight','Typed skills'),notice:'Adds a local hook; set OPT_OUT=0 to prevent it.',noticeLabel:'Setup change'};
  const entries=[{version:'9.0.0',notes:[note('highlight')]},{version:'8.0.0',notes:[setup,note()]}];
  const p=presentReleaseNotes(entries,true);
  expect(p.visiblePrevious[0].notes).toEqual([setup]);expect(p.history[0].notes).not.toContain(setup);
  const html=draw(entries,{running:'9.0.0',since:'7.0.0'});
  expect(html.indexOf('OPT_OUT=0')).toBeLessThan(html.indexOf('<details'));
  expect(html).toContain('Setup change: ');
 });
 it('validates semantic icons independently of release versions',()=>{
  expect(validateReleaseEditorial({'9.9.9':[{...note('highlight'),icon:'plans'}]})).toEqual([]);
  expect(validateReleaseEditorial({'9.9.9':[{...note('highlight'),icon:'unknown'}]}).length).toBeGreaterThan(0);
  const html=draw([{version:'9.9.9',notes:['plans','accounts','skills'].map(icon=>({...note('highlight'),icon}))}],{running:'9.9.9'});
  const icons=[...html.matchAll(/<span class="rn-title-icon"[^>]*>([\s\S]*?)<\/span>/g)].map(m=>m[1]);
  expect(icons).toHaveLength(3);expect(new Set(icons).size).toBe(3);
 });
 it('fails open for unclassified legacy upgrades instead of hiding possible warnings',()=>{
  const entries=[{version:'3.46.0',notes:[]},{version:'3.45.0',notes:[note(undefined,'Legacy warning')]}];
  const p=presentReleaseNotes(entries,true);expect(p.visiblePrevious[0].notes).toEqual(entries[1].notes);expect(p.history).toEqual([]);
 });
 it('validates notice types and editorial scan limits',()=>{
  for(const n of [{...note(),notice:3},{...note(),notice:''},{...note(),noticeLabel:'Setup change'},{...note(),notice:'Detail',noticeLabel:''},{...note(),notice:'Detail',noticeLabel:'x'.repeat(33)},{...note('highlight'),title:'x'.repeat(73)},{...note('highlight'),body:'x'.repeat(241)}]){
   expect(validateReleaseEditorial({'3.46.0':[n]}).length).toBeGreaterThan(0);
  }
 });
 it('uses factual notice labels without inferring impact from the release or text',()=>{
  const n={...note('highlight'),notice:'Changes settings.json.',noticeLabel:'Setup change'};
  expect(validateReleaseEditorial({'9.9.9':[n]})).toEqual([]);
  expect(readNotes({'9.9.9':[n]})[0].notes[0]).toEqual(n);
  expect(draw([{version:'3.46.0',notes:[n]}])).toContain('<strong>Setup change: </strong>');
  expect(draw([{version:'3.46.0',notes:[{...n,noticeLabel:undefined}]}])).toContain('<strong>Important: </strong>');
  expect(readNotes({'9.9.9':[{...n,noticeLabel:4}]})[0].notes[0]).toEqual({...n,noticeLabel:undefined});
 });
 it('keeps original notes when optional runtime metadata is malformed',()=>{
  expect(readNotes({'3.46.0':[{...note(),notice:7,priority:'oops'}]})[0].notes).toEqual([note()]);
 });
 it('fails open if too many highlights reach runtime',()=>{
  const notes=Array.from({length:4},()=>note('highlight'));
  const g=groupReleaseNotes(notes);expect(g.highlights).toHaveLength(3);expect(g.visible).toHaveLength(1);
 });
 it('reads optional summaries while retaining the old title/body format',()=>{
  expect(readNotes({'3.46.0':[note()],'//summaries':{'3.46.0':'Specific summary'}})[0].summary).toBe('Specific summary');
  expect(readNotes({'3.45.0':[note()]})[0]).toEqual({version:'3.45.0',notes:[note()]});
 });
 it('keeps required notes outside closed improvements and uses a fixed footer',()=>{
  const html=draw([{version:'3.46.0',notes:[note('highlight'),note('required','Required action'),note(undefined,'Extra detail')]}]);
  expect(html.indexOf('Required action')).toBeLessThan(html.indexOf('<details'));
  expect(html).toContain('More improvements');expect(html).toContain('1 update');
  expect(html).toContain('<footer class="rn-footer">');expect(html).toContain('>Done</button>');
  expect(html).toContain('https://ccdeck.dev/changelog/');expect(html).toContain('rel="noopener noreferrer"');
 });
 it('keeps empty manual releases honest instead of substituting historical content',()=>{
  expect(draw()).toContain('No release notes for this build.');
  expect(draw([{version:'3.46.0',notes:[]}])).toContain('No release notes for this build.');
  const html=draw([{version:'3.46.0',notes:[]},{version:'3.45.0',notes:[note(undefined,'Historical detail')]}]);
  expect(html).not.toContain('Historical detail');expect(html).not.toContain('class="rn-history"');expect(html).toContain('No release notes for this build.');
 });
 it('keeps verified desktop updates primary, without a second restart or tour',()=>{
  const html=draw([], {updateVersion:'3.47.0',onUpdateRestart:()=>{},onRestart:()=>{},onTour:()=>{},updateBusy:true,updateFailure:'Could not restart.'});
  expect(html).toContain('downloaded and verified');expect(html).toContain('Restarting…');expect(html).toContain('aria-busy="true"');
  expect(html).not.toContain('More options');expect(html).not.toContain('Take the tour');expect(html).toContain('role="status">Could not restart.');
 });
 it('keeps skipped legacy upgrades visible with transparent context',()=>{
  const html=draw([{version:'3.46.0',notes:[note('highlight')]},{version:'3.45.0',notes:[note(undefined,'Privacy details')]}],{since:'3.44.0'});
  expect(html).toContain('Changes since v3.44.0.');expect(html).toContain('Older notes are shown in full');
  expect(html).toContain('Privacy details');expect(html).not.toContain('Other changes since');
 });
 it('discloses optional earlier changes only for the actual upgrade range',()=>{
  const entries=[{version:'3.46.0',notes:[note('highlight')]},{version:'3.45.0',notes:[note('required','Keep visible'),note(undefined,'Optional detail')]}];
  const html=draw(entries,{since:'3.44.0'});
  expect(html.indexOf('Keep visible')).toBeLessThan(html.indexOf('<details'));
  expect(html).toContain('Other changes since v3.44.0');expect(html).toContain('Optional detail');expect(html).toContain('v3.45.0');
  expect(html).not.toContain('Previous releases');
 });
 it('keeps all seven current changes and hook qualifications visible with highlights',()=>{
  const current=RELEASE_NOTES.find(e=>e.version==='3.46.0')!;expect(current.notes).toHaveLength(7);
  const html=draw([current]);const visible=html.slice(0,html.indexOf('<details'));
  for(const s of ['UserPromptExpansion','settings.json','2.1.116','AGENTS_DECK_SKILL_HOOK=0'])expect(visible).toContain(s);
 });
});
