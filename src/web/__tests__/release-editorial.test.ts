import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { groupReleaseNotes, readNotes, validateReleaseEditorial, RELEASE_NOTES, type ReleaseNote } from '../release-notes';
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
 it('renders empty releases and multi-version history without losing content',()=>{
  expect(draw()).toContain('No release notes for this build.');
  const html=draw([{version:'3.46.0',notes:[]},{version:'3.45.0',notes:[note(undefined,'Historical detail')]}]);
  expect(html).toContain('Historical detail');expect(html).toContain('v3.45.0 – v3.46.0');
 });
 it('keeps verified desktop updates primary, without a second restart or tour',()=>{
  const html=draw([], {updateVersion:'3.47.0',onUpdateRestart:()=>{},onRestart:()=>{},onTour:()=>{},updateBusy:true,updateFailure:'Could not restart.'});
  expect(html).toContain('downloaded and verified');expect(html).toContain('Restarting…');expect(html).toContain('aria-busy="true"');
  expect(html).not.toContain('More options');expect(html).not.toContain('Take the tour');expect(html).toContain('role="status">Could not restart.');
 });
 it('shows running-version context when the current release has no notes',()=>{
  expect(draw([{version:'3.45.0',notes:[note()]}])).toContain('Running v3.46.0. Earlier release notes');
 });
 it('keeps all seven current changes and hook qualifications visible with highlights',()=>{
  const current=RELEASE_NOTES.find(e=>e.version==='3.46.0')!;expect(current.notes).toHaveLength(7);
  const html=draw([current]);const visible=html.slice(0,html.indexOf('<details'));
  for(const s of ['UserPromptExpansion','settings.json','2.1.116','AGENTS_DECK_SKILL_HOOK=0'])expect(visible).toContain(s);
 });
});
