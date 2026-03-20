import { createSignal, createEffect, For } from 'solid-js';
import { styled } from 'solid-styled-components';
import { useUmweltSpec } from '../../contexts/UmweltSpecContext';
import { useUmweltDatastore } from '../../contexts/UmweltDatastoreContext';
import { getData } from '../../util/datasets';
import {
  EncodingPropName, isVisualProp, isAudioProp, markTypes,
  visualPropNames, audioPropNames, MeasureType,
  VisualPropName, AudioPropName,
} from '../../types';
import { createStoredSignal } from '../../util/solid';
import { UmweltDataset } from '../../types';
import { VEGA_DATA_URL_PREFIX } from './data';

// ── Types ─────────────────────────────────────────────────────────────────────

type Role = 'agent' | 'user';
interface Message { role: Role; text: string; id: number; }

// Simplified step set — just 5 core steps + data loading steps
type Step =
  | 'data_source'       // waiting for dataset choice
  | 'data_example_choice'
  | 'data_url'
  | 'fields'            // waiting for field selection
  | 'confirm'           // chart created — confirm or request changes (loop)
  | 'done';             // finished

// ── Constants ─────────────────────────────────────────────────────────────────

const VEGA_DATASETS = [
  'stocks.csv', 'cars.json', 'weather.csv', 'seattle-weather.csv',
  'penguins.json', 'driving.json', 'barley.json', 'disasters.csv', 'gapminder.json',
];

const MEASURE_TYPES: MeasureType[] = ['quantitative', 'ordinal', 'nominal', 'temporal'];

// ── Channel & type aliases ────────────────────────────────────────────────────

const CHANNEL_ALIASES: Record<string, EncodingPropName> = {
  x: 'x', 'x axis': 'x', 'x-axis': 'x', horizontal: 'x',
  y: 'y', 'y axis': 'y', 'y-axis': 'y', vertical: 'y',
  color: 'color', colour: 'color', hue: 'color',
  shape: 'shape',
  size: 'size',
  opacity: 'opacity', transparency: 'opacity',
  pitch: 'pitch', frequency: 'pitch', note: 'pitch',
  volume: 'volume', loudness: 'volume',
  duration: 'duration', length: 'duration',
};

const TYPE_ALIASES: Record<string, MeasureType> = {
  quantitative: 'quantitative', quant: 'quantitative', numeric: 'quantitative', number: 'quantitative',
  ordinal: 'ordinal', ordered: 'ordinal', ranked: 'ordinal',
  nominal: 'nominal', categorical: 'nominal', category: 'nominal', discrete: 'nominal',
  temporal: 'temporal', time: 'temporal', date: 'temporal', datetime: 'temporal',
};

// ── Fuzzy helpers ─────────────────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-()\/]+/g, '');

const fieldMatchScore = (spoken: string, fieldName: string): number => {
  const ns = norm(spoken);
  const nf = norm(fieldName);
  if (nf === ns) return 100;
  if (nf.startsWith(ns) || ns.startsWith(nf)) return 80;
  if (nf.includes(ns) || ns.includes(nf)) return 60;
  const sToks = ns.match(/[a-z0-9]+/g) ?? [];
  const fToks = nf.match(/[a-z0-9]+/g) ?? [];
  const overlap = sToks.filter(t => fToks.some(ft => ft.includes(t) || t.includes(ft))).length;
  return overlap > 0 ? 20 + overlap * 10 : 0;
};

const bestFieldMatch = (spoken: string, pool: string[]): string | undefined => {
  let best = 0, match: string | undefined;
  for (const f of pool) {
    const s = fieldMatchScore(spoken, f);
    if (s > best) { best = s; match = f; }
  }
  return best > 0 ? match : undefined;
};

const resolveChannel = (spoken: string): EncodingPropName | undefined => {
  const lower = spoken.toLowerCase().trim();
  if (CHANNEL_ALIASES[lower]) return CHANNEL_ALIASES[lower];
  const key = Object.keys(CHANNEL_ALIASES).find(k => lower.includes(k) || k.includes(lower));
  return key ? CHANNEL_ALIASES[key] : undefined;
};

const resolveMeasureType = (spoken: string): MeasureType | undefined => {
  const lower = spoken.toLowerCase().trim();
  if (TYPE_ALIASES[lower]) return TYPE_ALIASES[lower];
  return Object.entries(TYPE_ALIASES).find(([k]) => lower.includes(k))?.[1];
};

const bestDatasetMatch = (text: string): string | undefined => {
  const needle = norm(text);
  let bestScore = 0, bestDataset: string | undefined;
  for (const d of VEGA_DATASETS) {
    const stem = norm(d.replace(/\.[^.]+$/, ''));
    if (needle.includes(stem) || stem.includes(needle)) {
      if (stem.length > bestScore) { bestScore = stem.length; bestDataset = d; }
    }
  }
  return bestDataset;
};

const parseFieldList = (text: string, pool: string[]): string[] => {
  const lower = text.toLowerCase().trim();
  if (/^all$|^everything$|^all fields$/.test(lower)) return pool;
  const exceptM = lower.match(/^(?:all|everything)(?:\s+(?:but|except|excluding|apart from|other than|minus))\s+(.+)$/);
  if (exceptM) {
    const parts = exceptM[1].split(/,\s*|\s+and\s+|\s*&\s*/).map(s => s.trim());
    return pool.filter(f => !parts.some(p => bestFieldMatch(p, [f])));
  }
  const parts = lower.split(/,\s*|\s+and\s+|\s*&\s*/).map(s => s.trim()).filter(Boolean);
  return pool.filter(f => parts.some(p => fieldMatchScore(p, f) > 0));
};

const parseEncodeCommand = (lower: string, fields: string[]): { field: string; channel: EncodingPropName } | null => {
  const patterns = [
    /(?:encode|map|set|assign|put|use|add)\s+(.+?)\s+(?:as|to|on|for|in|into)\s+(.+)/,
    /(.+?)\s+(?:as|to|on|onto)\s+(?:the\s+)?(.+?)\s*(?:axis|channel|field)?$/,
  ];
  for (const pat of patterns) {
    const m = lower.match(pat);
    if (m) {
      const field = bestFieldMatch(m[1].trim(), fields);
      const channel = resolveChannel(m[2].trim());
      if (field && channel) return { field, channel };
    }
  }
  return null;
};

// ── Typed encoding helpers ────────────────────────────────────────────────────

const getVisualEncodingField = (
  units: ReturnType<ReturnType<typeof useUmweltSpec>[0]['visual']['units']['map']> extends (infer U)[] ? U[] : never,
  unitName: string,
  prop: EncodingPropName,
): string | undefined => {
  if (!isVisualProp(prop)) return undefined;
  const unit = (units as any[]).find((u: any) => u.name === unitName);
  return unit?.encoding[prop as VisualPropName]?.field;
};

const getAudioEncodingField = (
  units: ReturnType<ReturnType<typeof useUmweltSpec>[0]['audio']['units']['map']> extends (infer U)[] ? U[] : never,
  unitName: string,
  prop: EncodingPropName,
): string | undefined => {
  if (!isAudioProp(prop)) return undefined;
  const unit = (units as any[]).find((u: any) => u.name === unitName);
  return unit?.encoding[prop as AudioPropName]?.field;
};

// ── Styled components ─────────────────────────────────────────────────────────

const Wrap = styled('div')`
  display: flex;
  flex-direction: column;
  border: 1px solid #ccc;
  border-radius: 6px;
  overflow: hidden;
  font-size: 13px;
  background: #fff;
`;

const History = styled('ol')`
  list-style: none;
  margin: 0;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 400px;
  overflow-y: auto;
  scroll-behavior: smooth;
`;

const MessageItem = styled('li')<{ msgrole: Role }>`
  max-width: 84%;
  padding: 6px 10px;
  border-radius: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  align-self: ${p => p.msgrole === 'user' ? 'flex-end' : 'flex-start'};
  background: ${p => p.msgrole === 'user' ? '#0070f3' : '#f0f0f0'};
  color: ${p => p.msgrole === 'user' ? '#fff' : '#222'};
`;

const Suggestions = styled('div')`
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 4px 12px 6px;
`;

const Chip = styled('button')`
  border: 1px solid #0070f3;
  background: #fff;
  color: #0070f3;
  border-radius: 12px;
  padding: 2px 10px;
  font-size: 12px;
  cursor: pointer;
  &:hover, &:focus { background: #e8f0fe; outline: 2px solid #0070f3; outline-offset: 1px; }
`;

const InputArea = styled('div')`
  display: flex;
  align-items: center;
  border-top: 1px solid #ddd;
  background: #fafafa;
`;

const ChatInput = styled('input')`
  flex: 1;
  border: none;
  outline: none;
  padding: 8px 10px;
  font-size: 13px;
  background: transparent;
  &:focus { outline: 2px solid #0070f3; outline-offset: -2px; }
`;

const IconBtn = styled('button')<{ active?: boolean }>`
  border: none;
  background: ${p => p.active ? '#d00' : 'transparent'};
  color: ${p => p.active ? '#fff' : '#555'};
  padding: 8px 10px;
  cursor: pointer;
  font-size: 15px;
  transition: background 0.15s;
  &:focus { outline: 2px solid #0070f3; outline-offset: 1px; }
`;

const SendBtn = styled('button')`
  border: none;
  background: #0070f3;
  color: #fff;
  padding: 8px 14px;
  cursor: pointer;
  font-size: 13px;
  &:hover, &:focus { background: #005ac4; outline: 2px solid #005ac4; outline-offset: 1px; }
  &:disabled { background: #aaa; cursor: default; }
`;

// ── Module-level persistent signals ───────────────────────────────────────────
// Outside the component so the conversation survives tab switches.

let _msgId = 0;
const _mk = (role: Role, text: string): Message => ({ role, text, id: _msgId++ });

const [messages, setMessages] = createSignal<Message[]>([
  _mk('agent',
    'Hi! Welcome to the Umwelt Conversational Agent.\n\n' +
    'How would you like to load your data?\n\n' +
    '1. Choose an example dataset\n' +
    '2. Load from a URL\n' +
    '3. Upload your own CSV or JSON file\n\n' +
    'You can also say "example dataset" at any time to browse available datasets.'
  ),
]);
const [step, setStep] = createSignal<Step>('data_source');
const [inputVal, setInputVal] = createSignal('');
const [listening, setListening] = createSignal(false);
const [suggestions, setSuggestions] = createSignal<string[]>([
  '1. Example dataset',
  '2. Load from URL',
  '3. Upload my own file',
]);
// Note: createEffect on mount will replace these if data is already loaded
const [liveMsg, setLiveMsg] = createSignal('');

// ── Component ──────────────────────────────────────────────────────────────────

export function ConversationAgent() {
  const [spec, specActions] = useUmweltSpec();
  const [, datastoreActions] = useUmweltDatastore();
  const mk = _mk;

  const [vegaCache, setVegaCache] = createStoredSignal<Record<string, UmweltDataset>>('vegaDatasetsCache2', {});

  let historyEl: HTMLOListElement | undefined;
  let inputEl: HTMLInputElement | undefined;
  let fileInputEl: HTMLInputElement | undefined;

  // ── Utilities ─────────────────────────────────────────────────────────────

  const scrollDown = () =>
    setTimeout(() => historyEl?.scrollTo({ top: historyEl.scrollHeight, behavior: 'smooth' }), 40);

  const announce = (text: string) => {
    setLiveMsg('');
    setTimeout(() => setLiveMsg(text), 50);
  };

  const push = (role: Role, text: string, chips: string[] = []) => {
    setMessages(m => [...m, mk(role, text)]);
    setSuggestions(chips);
    scrollDown();
    if (role === 'agent') announce(text);
  };

  const allFieldNames = () => spec.fields.map(f => f.name);
  const activeFieldNames = () => spec.fields.filter(f => f.active).map(f => f.name);

  const allUnits = () => [
    ...spec.visual.units.map(u => ({ name: u.name, type: 'visual' as const })),
    ...spec.audio.units.map(u => ({ name: u.name, type: 'audio' as const })),
  ];

  // ── Vega-Lite default field inference ────────────────────────────────────
  // x: temporal > nominal > ordinal
  // y: first quantitative that isn't x

  const inferDefaults = (): { xField: string; yField: string } | null => {
    const fields = spec.fields.filter(f => f.active);
    if (!fields.length) return null;
    const xField =
      fields.find(f => f.type === 'temporal')?.name ??
      fields.find(f => f.type === 'nominal')?.name ??
      fields.find(f => f.type === 'ordinal')?.name;
    const yField = fields.find(f => f.type === 'quantitative' && f.name !== xField)?.name;
    if (!xField || !yField) return null;
    return { xField, yField };
  };

  // ── Build summary of current chart state ─────────────────────────────────

  const buildSummary = (): string => {
    const lines: string[] = [];
    lines.push(`Dataset: ${spec.data.name || 'none'}`);
    if (spec.visual.units.length) {
      for (const u of spec.visual.units) {
        const encs = Object.entries(u.encoding)
          .filter(([, v]) => v?.field)
          .map(([ch, v]) => `${ch} = ${v!.field}`)
          .join(', ');
        lines.push(`Visual: "${u.name}" mark=${u.mark}${encs ? ` | ${encs}` : ''}`);
      }
    }
    if (spec.audio.units.length) {
      for (const u of spec.audio.units) {
        const encs = Object.entries(u.encoding)
          .filter(([, v]) => v?.field)
          .map(([ch, v]) => `${ch} = ${v!.field}`)
          .join(', ');
        lines.push(`Audio: "${u.name}"${encs ? ` | ${encs}` : ''}`);
      }
    }
    return lines.join('\n');
  };

  // ── Auto-create default chart ─────────────────────────────────────────────
  // Always called after data loads. Creates 1 bar visual unit + 1 audio unit
  // using Vega-Lite field-type heuristics. Then enters 'confirm' step.

  const autoCreateChart = () => {
    // Clear any existing units first for a clean slate
    for (const u of [...spec.visual.units]) specActions.removeVisualUnit(u.name);
    for (const u of [...spec.audio.units]) specActions.removeAudioUnit(u.name);

    const defaults = inferDefaults();

    if (!defaults) {
      // Not enough type variety — just create a unit and ask user to encode manually
      specActions.addVisualUnit();
      specActions.addAudioUnit();
      const vUnit = spec.visual.units[spec.visual.units.length - 1]?.name;
      if (vUnit) specActions.changeMark(vUnit, 'bar' as any);
      push('agent',
        `I've created a visual and audio unit but couldn't infer default encodings — the dataset may not have a clear mix of categorical and quantitative fields.\n\nFields: ${activeFieldNames().join(', ')}\n\nTell me what to encode — e.g. "encode price as x" or "change mark to line".`,
        activeFieldNames().slice(0, 3).map(f => `encode ${f} as x`)
      );
      setStep('confirm');
      return;
    }

    // Create visual unit with bar mark and x/y encodings
    specActions.addVisualUnit();
    const vUnit = spec.visual.units[spec.visual.units.length - 1]?.name;
    if (vUnit) {
      specActions.changeMark(vUnit, 'bar' as any);
      specActions.addEncoding(defaults.xField, 'x', vUnit);
      specActions.addEncoding(defaults.yField, 'y', vUnit);
    }

    // Create audio unit with pitch encoding on the quantitative field
    specActions.addAudioUnit();
    const aUnit = spec.audio.units[spec.audio.units.length - 1]?.name;
    if (aUnit) {
      specActions.addEncoding(defaults.yField, 'pitch', aUnit);
    }

    const xType = spec.fields.find(f => f.name === defaults.xField)?.type ?? '';
    const yType = spec.fields.find(f => f.name === defaults.yField)?.type ?? '';

    push('agent',
      `I've created a default chart for you:\n\n` +
      `📊 Bar chart\n` +
      `  • x = ${defaults.xField} (${xType})\n` +
      `  • y = ${defaults.yField} (${yType})\n\n` +
      `🔊 Audio unit\n` +
      `  • pitch = ${defaults.yField}\n\n` +
      `Does this look right, or would you like to make changes?`,
      ['Looks good!', 'Make changes']
    );
    setStep('confirm');
  };

  // ── Handle a change request in confirm step ───────────────────────────────
  // Free-form natural language change detection. Tries to understand what
  // the user wants and applies it directly. Returns a description of what
  // changed, or null if nothing was understood.

  // ── Encode on existing unit — always replaces the channel ───────────────
  // Removes any existing encoding on that channel first, then adds the new
  // one. This ensures "encode body_mass as y" replaces y rather than adding
  // a second y encoding.
  const encodeOnUnit = (field: string, channel: EncodingPropName, unitName: string, unitType: 'visual' | 'audio') => {
    // Find and remove any existing encoding on this channel in this unit
    if (unitType === 'visual') {
      const existing = getVisualEncodingField(spec.visual.units as any, unitName, channel);
      if (existing) specActions.removeEncoding(existing, channel, unitName);
    } else {
      const existing = getAudioEncodingField(spec.audio.units as any, unitName, channel);
      if (existing) specActions.removeEncoding(existing, channel, unitName);
    }
    specActions.setFieldActive(field, true);
    specActions.addEncoding(field, channel, unitName);
  };

  const applyChange = (lower: string, original: string): string | null => {
    const fieldNames = allFieldNames();

    // ── Change mark type ─────────────────────────────────────────────────
    // "line chart", "make it a scatter", "change to bar", "use point mark"
    const mark = (markTypes as string[]).find(m => new RegExp(`\\b${m}\\b`).test(lower));
    if (mark) {
      if (!spec.visual.units.length) {
        specActions.addVisualUnit();
      }
      const vUnit = spec.visual.units[spec.visual.units.length - 1]?.name;
      if (vUnit) specActions.changeMark(vUnit, mark as any);
      return `Changed mark to "${mark}"`;
    }

    // ── Remove audio unit ────────────────────────────────────────────────
    // "remove audio", "no audio", "remove audio unit"
    if (/remove\s+audio|no\s+audio|delete\s+audio/.test(lower)) {
      const units = [...spec.audio.units];
      if (!units.length) return 'No audio unit to remove';
      for (const u of units) specActions.removeAudioUnit(u.name);
      return 'Removed audio unit';
    }

    // ── Remove visual unit ───────────────────────────────────────────────
    if (/remove\s+visual|no\s+visual|delete\s+visual/.test(lower)) {
      const units = [...spec.visual.units];
      if (!units.length) return 'No visual unit to remove';
      for (const u of units) specActions.removeVisualUnit(u.name);
      return 'Removed visual unit';
    }

    // ── Add another visual unit ──────────────────────────────────────────
    // "add another visual unit", "add a line chart", "add visual"
    if (/add\s+(?:another\s+)?(?:a\s+)?visual|add\s+(?:a\s+)?(?:new\s+)?chart/.test(lower)) {
      specActions.addVisualUnit();
      const vUnit = spec.visual.units[spec.visual.units.length - 1]?.name;
      // Check if a mark was also mentioned
      const newMark = (markTypes as string[]).find(m => new RegExp(`\\b${m}\\b`).test(lower));
      if (vUnit && newMark) specActions.changeMark(vUnit, newMark as any);
      return `Added new visual unit${newMark ? ` with "${newMark}" mark` : ''}`;
    }

    // ── Add another audio unit ───────────────────────────────────────────
    if (/add\s+(?:another\s+)?(?:an?\s+)?audio/.test(lower)) {
      specActions.addAudioUnit();
      const aUnit = spec.audio.units[spec.audio.units.length - 1]?.name;
      const defaults = inferDefaults();
      if (aUnit && defaults) encodeOnUnit(defaults.yField, 'pitch', aUnit, 'audio');
      return 'Added new audio unit';
    }

    // ── Channel reassignment ─────────────────────────────────────────────
    // "change x to price", "set y to horsepower", "x should be date"
    // "use color for species", "encode species as color"
    const encCmd = parseEncodeCommand(lower, fieldNames);
    if (encCmd) {
      const { field, channel } = encCmd;
      const unit = allUnits().find(u =>
        (isVisualProp(channel) && u.type === 'visual') ||
        (isAudioProp(channel) && u.type === 'audio')
      );
      if (!unit) {
        // No matching unit — if it's a visual channel, use the first visual unit anyway
        if (isVisualProp(channel) && spec.visual.units.length) {
          const vUnit = spec.visual.units[0];
          encodeOnUnit(field, channel, vUnit.name, 'visual');
          return `Set ${channel} = ${field}`;
        }
        if (isAudioProp(channel) && spec.audio.units.length) {
          const aUnit = spec.audio.units[0];
          encodeOnUnit(field, channel, aUnit.name, 'audio');
          return `Set ${channel} = ${field}`;
        }
        const needed = isVisualProp(channel) ? 'visual' : 'audio';
        return `No ${needed} unit found — add one first`;
      }
      encodeOnUnit(field, channel, unit.name, unit.type);
      return `Set ${channel} = ${field}`;
    }

    // Try reversed pattern: "change x to price" / "change price to x"
    const revPatterns = [
      /(?:change|set|make|update)\s+(.+?)\s+to\s+(.+)/,
      /(?:use|put)\s+(.+?)\s+(?:for|on|as)\s+(.+)/,
      /(.+?)\s+=\s+(.+)/,
    ];
    for (const pat of revPatterns) {
      const m = lower.match(pat);
      if (!m) continue;
      const a = m[1].trim(), b = m[2].trim();
      // Try a=channel, b=field
      const chanA = resolveChannel(a);
      const fieldB = bestFieldMatch(b, fieldNames);
      if (chanA && fieldB) {
        const unit = allUnits().find(u =>
          (isVisualProp(chanA) && u.type === 'visual') ||
          (isAudioProp(chanA) && u.type === 'audio')
        );
        if (unit) {
          encodeOnUnit(fieldB, chanA, unit.name, unit.type);
          return `Set ${chanA} = ${fieldB}`;
        }
      }
      // Try a=field, b=channel
      const fieldA = bestFieldMatch(a, fieldNames);
      const chanB = resolveChannel(b);
      if (fieldA && chanB) {
        const unit = allUnits().find(u =>
          (isVisualProp(chanB) && u.type === 'visual') ||
          (isAudioProp(chanB) && u.type === 'audio')
        );
        if (unit) {
          encodeOnUnit(fieldA, chanB, unit.name, unit.type);
          return `Set ${chanB} = ${fieldA}`;
        }
      }
    }

    // ── Remove an encoding ───────────────────────────────────────────────
    // "remove price from x", "remove x encoding"
    const removeM = lower.match(/remove\s+(.+?)\s+(?:from\s+)?(.+)/);
    if (removeM) {
      const fieldName = bestFieldMatch(removeM[1], fieldNames);
      const prop = resolveChannel(removeM[2]);
      if (fieldName && prop) {
        const unit = allUnits().find(u =>
          u.type === 'visual'
            ? getVisualEncodingField(spec.visual.units as any, u.name, prop) === fieldName
            : getAudioEncodingField(spec.audio.units as any, u.name, prop) === fieldName
        );
        if (unit) {
          specActions.removeEncoding(fieldName, prop, unit.name);
          return `Removed "${fieldName}" from ${prop}`;
        }
      }
    }

    // ── Change active fields ─────────────────────────────────────────────
    // "use only date and price", "only show temperature and humidity"
    if (/use only|only use|only show|just use|just show/.test(lower)) {
      const selected = parseFieldList(original, fieldNames);
      if (selected.length) {
        spec.fields.forEach(f => specActions.setFieldActive(f.name, selected.includes(f.name)));
        // Re-run auto encoding with new active fields
        const defaults = inferDefaults();
        const vUnit = spec.visual.units[0]?.name;
        if (defaults && vUnit) {
          encodeOnUnit(defaults.xField, 'x', vUnit, 'visual');
          encodeOnUnit(defaults.yField, 'y', vUnit, 'visual');
          const aUnit = spec.audio.units[0]?.name;
          if (aUnit) encodeOnUnit(defaults.yField, 'pitch', aUnit, 'audio');
        }
        return `Changed active fields to: ${selected.join(', ')}`;
      }
    }

    // ── Change field type ────────────────────────────────────────────────
    // "date is temporal", "price is quantitative"
    const typeM = lower.match(/^(.+?)\s+(?:is|as|=)\s+(.+)$/);
    if (typeM) {
      const fieldName = bestFieldMatch(typeM[1], fieldNames);
      const mtype = resolveMeasureType(typeM[2]);
      if (fieldName && mtype) {
        specActions.setFieldType(fieldName, mtype);
        return `Set "${fieldName}" type to ${mtype}`;
      }
    }

    return null;
  };

  // ── Confirmation prompt ───────────────────────────────────────────────────
  // Shown after auto-create and after each change.

  const confirmPrompt = (changed?: string) => {
    const summary = buildSummary();
    if (changed) {
      push('agent',
        `Done — ${changed}.\n\n${summary}\n\nAnything else, or does this look good?`,
        ['Looks good!', 'Change mark type', 'Change x field', 'Change y field', 'Add audio unit', 'Remove audio unit']
      );
    } else {
      push('agent',
        `${summary}\n\nDoes this look right, or would you like to make changes?`,
        ['Looks good!', 'Make changes']
      );
    }
  };

  // ── Restart ───────────────────────────────────────────────────────────────

  // buildRestartMessage is a plain function (not reactive) so it reads
  // spec.data.name at call time — the current value when restart runs.
  const buildRestartMessage = (): { text: string; chips: string[] } => {
    const loaded = spec.data.name;
    if (loaded) {
      return {
        text:
          `What would you like to do?\n\n` +
          `1. Keep using "${loaded}" (already loaded)\n` +
          `2. Choose a different example dataset\n` +
          `3. Load from a URL\n` +
          `4. Upload your own CSV or JSON file`,
        chips: [
          `1. Keep using ${loaded}`,
          '2. Example dataset',
          '3. Load from URL',
          '4. Upload my file',
        ],
      };
    }
    return {
      text:
        'How would you like to load your data?\n\n' +
        '1. Choose an example dataset\n' +
        '2. Load from a URL\n' +
        '3. Upload your own CSV or JSON file',
      chips: ['1. Example dataset', '2. Load from URL', '3. Upload my own file'],
    };
  };

  const doRestart = () => {
    const { text, chips } = buildRestartMessage();
    setMessages([mk('agent', text)]);
    setSuggestions(chips);
    setStep('data_source');
    announce('Restarted.');
  };

  // ── Data loading ──────────────────────────────────────────────────────────

  const onDataReady = () => {
    // Short delay to let the spec settle after initializeData
    setTimeout(() => {
      const names = spec.fields.map(f => f.name);

      // Check if user pre-specified fields in their original message
      // (e.g. "bar chart of date and price in stocks")
      // For now just activate all fields — user can narrow down in confirm step
      spec.fields.forEach(f => specActions.setFieldActive(f.name, true));

      push('agent',
        `Data loaded! Fields: ${names.join(', ')}.\n\nWhich fields would you like to use? Say "all" or list specific ones.`,
        ['all', ...names.slice(0, 4)]
      );
      setStep('fields');
    }, 300);
  };

  const loadVega = (filename: string) => {
    const cache = vegaCache();
    const doLoad = (data: UmweltDataset) => {
      datastoreActions.setDataset(filename, data, filename);
      specActions.initializeData(filename);
      onDataReady();
    };
    if (cache[filename]) { doLoad(cache[filename]); return; }
    getData(`${VEGA_DATA_URL_PREFIX}${filename}`).then(data => {
      if (data?.length) { setVegaCache({ ...vegaCache(), [filename]: data }); doLoad(data); }
      else push('agent', `Couldn't load "${filename}". Try another.`, VEGA_DATASETS);
    });
  };

  const loadUrl = (url: string) => {
    const filename = url.split('/').pop() || url;
    getData(url).then(data => {
      if (data?.length) {
        datastoreActions.setDataset(filename, data, url);
        specActions.initializeData(filename);
        onDataReady();
      } else {
        push('agent', "Couldn't fetch data from that URL. Please check it and try again.");
      }
    });
  };

  // ── File upload ───────────────────────────────────────────────────────────

  const parseFileContent = (filename: string, text: string): UmweltDataset | null => {
    try {
      const ext = filename.split('.').pop()?.toLowerCase();
      if (ext === 'json') {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : null;
      }
      if (ext === 'csv' || ext === 'tsv') {
        const sep = ext === 'tsv' ? '\t' : ',';
        const lines = text.trim().split('\n').filter(Boolean);
        if (lines.length < 2) return null;
        const headers = lines[0].split(sep).map(h => h.trim().replace(/^"|"$/g, ''));
        return lines.slice(1).map(line => {
          const vals = line.split(sep).map(v => v.trim().replace(/^"|"$/g, ''));
          const row: Record<string, any> = {};
          headers.forEach((h, i) => {
            const v = vals[i] ?? '';
            const n = Number(v);
            row[h] = v !== '' && !isNaN(n) ? n : v;
          });
          return row;
        });
      }
      return null;
    } catch { return null; }
  };

  const loadFile = (file: File) => {
    push('agent', `Reading "${file.name}". Please wait.`);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const data = parseFileContent(file.name, text);
      if (data && data.length) {
        datastoreActions.setDataset(file.name, data, file.name);
        specActions.initializeData(file.name);
        onDataReady();
      } else {
        push('agent',
          `Couldn't parse "${file.name}". Make sure it's a valid CSV or JSON file.\nCSV: first row must be headers.\nJSON: must be an array of objects.`
        );
      }
    };
    reader.onerror = () => push('agent', `Failed to read "${file.name}". Please try again.`);
    reader.readAsText(file);
  };

  const triggerFileUpload = () => fileInputEl?.click();

  // ── Show the right opening prompt on mount ───────────────────────────────
  // Runs once when the component first mounts. If data is already loaded,
  // the opening message is replaced with one that includes it as option 1.
  // Uses a one-shot effect that only fires at data_source step.

  createEffect(() => {
    if (step() !== 'data_source') return;
    if (!spec.data.name || !spec.fields.length) return;

    // Data is already loaded — rewrite the opening message to include it
    const loaded = spec.data.name;
    setMessages([mk('agent',
      `I can see "${loaded}" is already loaded.\n\n` +
      `What would you like to do?\n\n` +
      `1. Use "${loaded}" (already loaded)\n` +
      `2. Choose a different example dataset\n` +
      `3. Load from a URL\n` +
      `4. Upload your own CSV or JSON file`
    )]);
    setSuggestions([
      `1. Use ${loaded}`,
      '2. Example dataset',
      '3. Load from URL',
      '4. Upload my file',
    ]);
  });

  // ── Global commands ───────────────────────────────────────────────────────
  // These work at any step.

  const handleGlobal = (lower: string, original: string): boolean => {
    if (/\brestart\b|start over|reset|begin again/.test(lower)) {
      doRestart(); return true;
    }
    if (/\bsummary\b|what have i|where am i|what'?s set|show me what/.test(lower)) {
      push('agent', buildSummary(), ['Make changes', 'Looks good!', 'Restart']);
      return true;
    }
    if (/\bupload\b|my file|my own|from my computer/.test(lower)) {
      push('agent', 'Click the 📎 button below to upload a CSV or JSON file.');
      triggerFileUpload();
      return true;
    }

    // Global: show example datasets list at any step
    if (/example dataset|choose a dataset|load a dataset|switch dataset|change dataset|use a dataset|pick a dataset|show datasets|list datasets/.test(lower)) {
      push('agent',
        `Here are the available example datasets:\n\n${VEGA_DATASETS.map((d, i) => `${i + 1}. ${d.replace(/\.[^.]+$/, '')}`).join('\n')}\n\nWhich one would you like to load?`,
        VEGA_DATASETS.map(d => d.replace(/\.[^.]+$/, ''))
      );
      setStep('data_example_choice');
      return true;
    }

    return false;
  };

  // ── Main input handler ────────────────────────────────────────────────────

  const handleInput = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    push('user', text);
    setInputVal('');
    inputEl?.focus();
    const lower = text.toLowerCase();

    if (handleGlobal(lower, text)) return;

    switch (step()) {

      // ── data_source: waiting for user to name a dataset or choose option ──
      case 'data_source': {
        const urlM = text.match(/https?:\/\/\S+/);
        if (urlM) { push('agent', 'Fetching data. Please wait.'); loadUrl(urlM[0]); break; }

        const ds = bestDatasetMatch(lower);
        if (ds) { push('agent', `Loading "${ds}". Please wait.`); loadVega(ds); break; }

        if (/\b1\b|example/.test(lower)) {
          push('agent',
            `Here are the available example datasets:\n\n${VEGA_DATASETS.map((d, i) => `${i + 1}. ${d}`).join('\n')}\n\nWhich one would you like?`,
            VEGA_DATASETS
          );
          setStep('data_example_choice');
        } else if (/\b2\b|url|http/.test(lower)) {
          push('agent', 'Paste the URL to your JSON or CSV dataset below.');
          setStep('data_url');
        } else if (/\b3\b|upload|my file|my own|from my computer/.test(lower)) {
          push('agent', 'Click the 📎 button below to select a CSV or JSON file from your computer.');
          triggerFileUpload();
        } else if (/\b1\b|keep|already loaded|use.*loaded|continue|same data/.test(lower) && spec.data.name) {
          // User chose to keep the already-loaded dataset
          spec.fields.forEach(f => specActions.setFieldActive(f.name, true));
          push('agent', `Great — using "${spec.data.name}". Creating your chart now…`);
          setTimeout(() => autoCreateChart(), 150);
        } else {
          // Rebuild the prompt in case data loaded/changed
          const { text, chips } = buildRestartMessage();
          push('agent', text, chips);
        }
        break;
      }

      case 'data_example_choice': {
        const hit = bestDatasetMatch(lower);
        if (hit) { push('agent', `Loading "${hit}". Please wait.`); loadVega(hit); }
        else push('agent', `Didn't recognise that. Options:\n${VEGA_DATASETS.join(', ')}`, VEGA_DATASETS);
        break;
      }

      case 'data_url': {
        const urlM = text.match(/https?:\/\/\S+/);
        if (urlM) { push('agent', 'Fetching data. Please wait.'); loadUrl(urlM[0]); }
        else push('agent', "That doesn't look like a valid URL. It must start with https://");
        break;
      }

      // ── fields: user selects which fields to use ───────────────────────
      case 'fields': {
        const names = allFieldNames();
        const selected = parseFieldList(text, names);

        if (!selected.length) {
          push('agent',
            `No matching fields found. Available: ${names.join(', ')}.\nTry "all", "all but X", or list field names.`,
            ['all', ...names.slice(0, 4)]
          );
          break;
        }

        // Activate selected fields, deactivate the rest
        spec.fields.forEach(f => specActions.setFieldActive(f.name, selected.includes(f.name)));

        push('agent', `Got it — using: ${selected.join(', ')}. Creating your chart now…`);

        // Small delay so spec updates settle before we read field types
        setTimeout(() => autoCreateChart(), 150);
        break;
      }

      // ── confirm: chart exists — user can say looks good or describe changes
      case 'confirm': {

        // Done signals
        if (/looks good|done|finish|perfect|great|all good|that'?s?\s*(it|fine|great|good)|yes|ok$|okay/.test(lower)) {
          push('agent',
            `Great! Your chart is ready.\n\n${buildSummary()}\n\nYou can say "make changes" or "restart" at any time.`,
            ['Make changes', 'Restart']
          );
          setStep('done');
          break;
        }

        // Try to understand and apply the change
        const changed = applyChange(lower, text);
        if (changed) {
          confirmPrompt(changed);
        } else {
          // Couldn't understand — give helpful examples
          push('agent',
            `I didn't quite understand that change. Here are some things you can say:\n` +
            `  • "line chart" or "change to scatter"\n` +
            `  • "change x to temperature" or "set color to species"\n` +
            `  • "add another audio unit" or "remove audio"\n` +
            `  • "encode humidity as y"\n` +
            `  • "use only date and price"\n\n` +
            `Or say "looks good" when you're happy.`,
            ['Looks good!', 'Line chart', 'Change x field', 'Add audio unit', 'Remove audio unit']
          );
        }
        break;
      }

      // ── done: chart is complete ────────────────────────────────────────
      case 'done': {
        // Even in done state, accept changes naturally
        const changed = applyChange(lower, text);
        if (changed) {
          push('agent',
            `Done — ${changed}.\n\n${buildSummary()}\n\nAnything else?`,
            ['Looks good!', 'Make more changes', 'Restart']
          );
        } else if (/make changes|edit|change|update|modify/.test(lower)) {
          push('agent',
            `Sure! What would you like to change?\n\nCurrent state:\n${buildSummary()}\n\nYou can say things like "line chart", "change x to date", or "add audio unit".`,
            ['Line chart', 'Change x field', 'Change y field', 'Add audio unit', 'Remove audio']
          );
          setStep('confirm');
        } else {
          push('agent',
            `Chart is ready. Say "make changes" to edit, "summary" to review, or "restart" to start over.`,
            ['Make changes', 'Summary', 'Restart']
          );
        }
        break;
      }
    }
  };

  // ── Speech ────────────────────────────────────────────────────────────────

  const startListening = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { push('agent', 'Speech recognition not supported. Please use Chrome.'); return; }
    const rec = new SR();
    rec.lang = 'en-US'; rec.interimResults = false; rec.maxAlternatives = 1;
    setListening(true);
    announce('Listening…');
    rec.start();
    rec.onresult = (e: any) => handleInput(e.results[0][0].transcript);
    rec.onerror = (e: any) => {
      setListening(false);
      const msgs: Record<string, string> = {
        network: 'Network error. Check your connection.',
        'not-allowed': 'Microphone access denied.',
        'no-speech': 'No speech detected.',
        'audio-capture': 'No microphone found.',
      };
      push('agent', msgs[e.error] ?? `Speech error: ${e.error}.`);
    };
    rec.onend = () => setListening(false);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div role="tabpanel" id="tabpanel-conversationAgent" aria-labelledby="tab-conversationAgent">
      <h2>Conversational Agent</h2>

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0,0,0,0)', 'white-space': 'nowrap' }}
      >
        {liveMsg()}
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputEl}
        type="file"
        accept=".csv,.json,.tsv"
        style={{ display: 'none' }}
        aria-hidden="true"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          if (file) { loadFile(file); e.currentTarget.value = ''; }
        }}
      />

      <Wrap>
        <History ref={historyEl} aria-label="Conversation history" aria-live="off">
          <For each={messages()}>
            {(msg) => (
              <MessageItem
                msgrole={msg.role}
                aria-label={`${msg.role === 'agent' ? 'Agent' : 'You'}: ${msg.text}`}
              >
                {msg.text}
              </MessageItem>
            )}
          </For>
        </History>

        {suggestions().length > 0 && (
          <Suggestions role="group" aria-label="Suggested replies">
            <For each={suggestions()}>
              {(chip) => (
                <Chip onClick={() => handleInput(chip)} aria-label={`Send: ${chip}`}>
                  {chip}
                </Chip>
              )}
            </For>
          </Suggestions>
        )}

        <InputArea>
          <IconBtn
            active={listening()}
            onClick={startListening}
            aria-label={listening() ? 'Listening' : 'Start voice input'}
            aria-pressed={listening()}
          >
            <span aria-hidden="true">🎤</span>
          </IconBtn>
          <IconBtn
            onClick={triggerFileUpload}
            aria-label="Upload a CSV or JSON file"
            title="Upload file"
          >
            <span aria-hidden="true">📎</span>
          </IconBtn>
          <ChatInput
            ref={inputEl}
            placeholder="Type a message and press Enter…"
            value={inputVal()}
            aria-label="Type your message"
            aria-describedby="chat-hint"
            onInput={e => setInputVal(e.currentTarget.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleInput(inputVal()); }}
          />
          <IconBtn
            onClick={doRestart}
            aria-label="Restart conversation"
            title="Restart"
          >
            <span aria-hidden="true">↺</span>
          </IconBtn>
          <SendBtn
            onClick={() => handleInput(inputVal())}
            disabled={!inputVal().trim()}
            aria-label="Send message"
          >
            Send
          </SendBtn>
        </InputArea>
      </Wrap>

      <p id="chat-hint" style={{ 'font-size': '12px', color: '#666', margin: '4px 0 0' }}>
        Upload your own CSV or JSON with 📎, or name an example dataset.
        After the chart is created, describe any changes — e.g. "line chart", "change x to date", "add audio unit".
        Say "summary" or "restart" at any time.
      </p>
    </div>
  );
}