import { useState } from 'react';
import { useT } from '../i18n';
import { countOf } from '../tool-audit-report';
import { ringArcs } from '../time-split';
import type { OriginShare, SkillOrigin } from '../skill-activity';

const FilterGlyph = () => <svg className="tt-caret" width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"
  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 3h10L8.5 7.5V11l-3 1.5v-5Z" /></svg>;

/** Who starts the period's skills, beside Worth a look: a ring of Claude picking a
 *  skill on its own, Codex doing the same, and you typing one, with a legend that
 *  says each share and the skill it mostly was. A skill Claude never picks itself
 *  is one whose description does not match how you ask. Pressing a lane keeps the
 *  list below to the skills started that way. */
export default function SkillOrigins({ shares, total, filter, onFilter }: {
  shares: OriginShare[]; total: number; filter: SkillOrigin | null; onFilter: (origin: SkillOrigin | null) => void;
}) {
  const t = useT();
  const [hot, setHot] = useState<SkillOrigin | null>(null);
  const focus = shares.find(part => part.id === (hot ?? filter) && part.uses > 0) ?? null;
  const toggle = (id: SkillOrigin) => onFilter(filter === id ? null : id);
  return <section className="tt" aria-labelledby="sa-origins-title" data-focus={focus?.id}>
    <div className="tt-head"><h3 id="sa-origins-title">{t('insights.skills.origins.title')}</h3><span className="tt-scope">{countOf(total, 'use')}</span></div>
    <div className="tt-card" onPointerLeave={() => setHot(null)}>
      <div className="tt-donut">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          {ringArcs(shares.map(part => ({ id: part.id, value: part.uses }))).map(arc => <circle key={arc.id} className="tt-arc" data-lane={arc.id} data-on={focus?.id === arc.id || undefined}
            cx="60" cy="60" r="52" pathLength={100} style={{ strokeDasharray: `${arc.length} ${100 - arc.length}`, strokeDashoffset: -arc.from }}
            onPointerEnter={() => setHot(arc.id)} onClick={() => toggle(arc.id)} />)}
        </svg>
        <div className="tt-center" aria-hidden="true">
          {focus ? <><strong>{focus.share}</strong><span>{focus.label}</span></> : <><strong>{total.toLocaleString()}</strong><span>{t('insights.skills.unit.uses', { count: total })}</span></>}
        </div>
      </div>
      <ul className="tt-lanes">
        {shares.map(part => <li key={part.id}>
          <button type="button" className="tt-lane" data-lane={part.id} aria-pressed={filter === part.id} disabled={!part.uses}
            aria-label={t('insights.skills.origins.aria', { label: part.label, value: part.uses ? t('insights.skills.origins.value', { share: part.share, uses: countOf(part.uses, 'use') }) : t('insights.skills.origins.notCounted'), fact: part.fact, action: t(filter === part.id ? 'insights.skills.origins.showing' : 'insights.skills.origins.show') })}
            onClick={() => toggle(part.id)} onPointerEnter={() => setHot(part.id)} onFocus={() => setHot(part.id)} onBlur={() => setHot(null)}>
            <i aria-hidden="true" /><span className="tt-lane-name">{part.label}</span><strong>{part.uses ? part.share : '—'}</strong>
            <span className="tt-lane-time">{part.uses.toLocaleString()}</span>{part.uses > 0 && <FilterGlyph />}
            <span className="tt-lane-fact">{part.fact}</span>
          </button>
        </li>)}
      </ul>
    </div>
  </section>;
}
