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

type Step =
  | 'data_source'
  | 'data_example_choice'
  | 'data_url'
  | 'fields'
  | 'modality'
  | 'visual_mark'
  | 'encoding'
  | 'encoding_which_unit'
  | 'field_review'
  | 'field_review_type'
  | 'field_review_enc'
  | 'edit_menu'
  | 'edit_dataset'
  | 'edit_fields'
  | 'edit_mark'
  | 'edit_encoding_remove'
  | 'edit_encoding_add'
  | 'edit_type'
  | 'done';

interface PendingEncoding { field: string; channel: EncodingPropName; }

// ── Constants ─────────────────────────────────────────────────────────────────

const VEGA_DATASETS = [
  'stocks.csv', 'cars.json', 'weather.csv', 'seattle-weather.csv',
  'penguins.json', 'driving.json', 'barley.json', 'disasters.csv', 'gapminder.json',
];

const MEASURE_TYPES: MeasureType[] = ['quantitative', 'ordinal', 'nominal', 'temporal'];

// ── Channel aliases ───────────────────────────────────────────────────────────

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

const parseEncodeCommand = (lower: string, activeFields: string[]): { field: string; channel: EncodingPropName } | null => {
  const patterns = [
    /(?:encode|map|set|assign|put|use|add)\s+(.+?)\s+(?:as|to|on|for|in|into)\s+(.+)/,
    /(.+?)\s+(?:as|to|on|onto)\s+(?:the\s+)?(.+?)\s*(?:axis|channel|field)?$/,
  ];
  for (const pat of patterns) {
    const m = lower.match(pat);
    if (m) {
      const field = bestFieldMatch(m[1].trim(), activeFields);
      const channel = resolveChannel(m[2].trim());
      if (field && channel) return { field, channel };
    }
  }
  return null;
};

// ── Typed encoding helpers ─────────────────────────────────────────────────────

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

// ── Module-level persistent state ─────────────────────────────────────────────
// Declared OUTSIDE the component so signals survive tab switches.
// SolidJS recreates components on mount/unmount, so any signal inside the
// component resets when the user switches tabs. Hoisting them here means
// the conversation persists as long as the page is open.

let _msgId = 0;
const _mk = (role: Role, text: string): Message => ({ role, text, id: _msgId++ });

const [messages, setMessages] = createSignal<Message[]>([
  _mk('agent', 'Hi! What would you like to visualise?\n\nYou can describe the whole chart at once — e.g. "bar chart of weather data" — and I\'ll set it up for you automatically.'),
]);
const [step, setStep] = createSignal<Step>('data_source');
const [inputVal, setInputVal] = createSignal('');
const [listening, setListening] = createSignal(false);
const [suggestions, setSuggestions] = createSignal<string[]>(['Example dataset', 'Load from URL']);
const [liveMsg, setLiveMsg] = createSignal('');

// Standard flow state
const [reviewQueue, setReviewQueue] = createSignal<string[]>([]);
const [reviewField, setReviewField] = createSignal<string | null>(null);
const [pendingModality, setPendingModality] = createSignal<'visual' | 'audio' | 'both' | null>(null);
const [pendingEncField, setPendingEncField] = createSignal<string | null>(null);
const [pendingEncProp, setPendingEncProp] = createSignal<EncodingPropName | null>(null);
const [stepBeforeEdit, setStepBeforeEdit] = createSignal<Step>('encoding');

// Lookahead slots
const [slotDataset, setSlotDataset] = createSignal<string | null>(null);
const [slotMark, setSlotMark] = createSignal<string | null>(null);
const [slotFields, setSlotFields] = createSignal<string[] | null>(null);
const [slotModality, setSlotModality] = createSignal<'visual' | 'audio' | 'both' | null>(null);
const [slotEncodings, setSlotEncodings] = createSignal<PendingEncoding[]>([]);

// ── Component ─────────────────────────────────────────────────────────────────

export function ConversationAgent() {
  const [spec, specActions] = useUmweltSpec();
  const [, datastoreActions] = useUmweltDatastore();

  const mk = _mk;

  const [vegaCache, setVegaCache] = createStoredSignal<Record<string, UmweltDataset>>('vegaDatasetsCache2', {});

  let historyEl: HTMLOListElement | undefined;
  let inputEl: HTMLInputElement | undefined;

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
    if (role === 'agent') announce(text + (chips.length ? ` Suggested: ${chips.join(', ')}.` : ''));
  };

  const activeFields = () => spec.fields.filter(f => f.active);
  const activeFieldNames = () => activeFields().map(f => f.name);

  const allUnits = () => [
    ...spec.visual.units.map(u => ({ name: u.name, type: 'visual' as const })),
    ...spec.audio.units.map(u => ({ name: u.name, type: 'audio' as const })),
  ];

  // ── Default to already-loaded dataset ────────────────────────────────────
  // If the viewer already has a dataset (user loaded data on the Data tab
  // before opening the agent), skip data_source and acknowledge it.
  createEffect(() => {
    if (step() === 'data_source' && spec.data.name && spec.fields.length) {
      const defaults = inferDefaultFields();
      const suggestion = defaults ? `${defaults.xField} and ${defaults.yField}` : null;
      push('agent',
        `I can see "${spec.data.name}" is already loaded with fields: ${spec.fields.map(f => f.name).join(', ')}.\n\n` +
        `Which fields would you like to use? Say "all" or list them. Or describe a chart — e.g. "bar chart".` +
        (suggestion ? `\n\nSuggested based on field types: ${suggestion}` : ''),
        [
          ...(suggestion ? [suggestion] : []),
          'all',
          ...spec.fields.map(f => f.name).slice(0, 3),
        ]
      );
      setStep('fields');
    }
  });

  // ── Vega-Lite style smart default field selection ─────────────────────────
  // Replicates Vega-Lite's auto-encoding heuristic:
  //   x axis: temporal > nominal > ordinal (categorical/time axis)
  //   y axis: first quantitative field (measure axis)
  // Falls back gracefully if some types are missing.

  const inferDefaultFields = (): { xField: string; yField: string } | null => {
    const fields = spec.fields;
    if (!fields.length) return null;

    // x axis priority: temporal first (best for time series), then nominal, then ordinal
    const xField =
      fields.find(f => f.type === 'temporal')?.name ??
      fields.find(f => f.type === 'nominal')?.name ??
      fields.find(f => f.type === 'ordinal')?.name;

    // y axis: first quantitative field that isn't already chosen for x
    const yField = fields.find(f => f.type === 'quantitative' && f.name !== xField)?.name;

    // Need both to proceed
    if (!xField || !yField) return null;
    return { xField, yField };
  };

  // ── Slot extractor ────────────────────────────────────────────────────────
  // Runs on EVERY user message. Scans for useful info and stores it for
  // later auto-use, without interrupting the conversation flow.

  const extractSlots = (text: string, allFieldNames: string[]) => {
    const lower = text.toLowerCase();

    if (!spec.data.name && !slotDataset()) {
      const ds = bestDatasetMatch(lower);
      if (ds) setSlotDataset(ds);
    }

    if (!slotMark()) {
      const mark = (markTypes as string[]).find(m => new RegExp(`\\b${m}\\b`).test(lower));
      if (mark) setSlotMark(mark);
    }

    if (!slotModality()) {
      const hasV = /\bvisual\b/.test(lower);
      const hasA = /\baudio\b/.test(lower);
      const hasB = /\bboth\b/.test(lower);
      if (hasB || (hasV && hasA)) setSlotModality('both');
      else if (hasA) setSlotModality('audio');
      else if (hasV) setSlotModality('visual');
    }

    if (allFieldNames.length && !slotFields()) {
      const parsed = parseFieldList(text, allFieldNames);
      if (parsed.length > 0 && parsed.length < allFieldNames.length) setSlotFields(parsed);
      else if (/\ball\b/.test(lower)) setSlotFields(allFieldNames);
    }

    if (allFieldNames.length) {
      const enc = parseEncodeCommand(lower, allFieldNames);
      if (enc) {
        setSlotEncodings(prev =>
          prev.some(e => e.field === enc.field && e.channel === enc.channel)
            ? prev
            : [...prev, enc]
        );
      }
    }
  };

  // ── Summary builder ───────────────────────────────────────────────────────

  const buildSummary = (): string => {
    const lines: string[] = ['Current configuration:'];
    lines.push(`Dataset: ${spec.data.name || 'none loaded'}`);
    const active = activeFieldNames();
    lines.push(`Active fields: ${active.length ? active.join(', ') : 'none'}`);
    if (spec.visual.units.length) {
      for (const unit of spec.visual.units) {
        const encs = Object.entries(unit.encoding)
          .filter(([, v]) => v?.field)
          .map(([ch, v]) => `${ch} = ${v!.field}`)
          .join(', ');
        lines.push(`Visual unit "${unit.name}": mark = ${unit.mark}${encs ? `, encodings: ${encs}` : ', no encodings'}`);
      }
    } else { lines.push('Visual units: none'); }
    if (spec.audio.units.length) {
      for (const unit of spec.audio.units) {
        const encs = Object.entries(unit.encoding)
          .filter(([, v]) => v?.field)
          .map(([ch, v]) => `${ch} = ${v!.field}`)
          .join(', ');
        lines.push(`Audio unit "${unit.name}":${encs ? ` encodings: ${encs}` : ' no encodings'}`);
      }
    } else { lines.push('Audio units: none'); }
    return lines.join('\n');
  };

  const encodingPrompt = () => {
    const mod = pendingModality();
    const channels = mod === 'audio'
      ? (audioPropNames as readonly string[]).join(', ')
      : mod === 'visual'
        ? (visualPropNames as readonly string[]).join(', ')
        : `visual: ${(visualPropNames as readonly string[]).join(', ')} | audio: ${(audioPropNames as readonly string[]).join(', ')}`;
    return `Fields: ${activeFieldNames().join(', ')}.\nChannels: ${channels}.\n\nSay "encode <field> as <channel>", or "done" to finish.`;
  };

  // ── Restart ───────────────────────────────────────────────────────────────

  const doRestart = () => {
    setMessages([_mk('agent', 'Restarting. What would you like to visualise? You can describe the whole chart at once.')]);
    setSuggestions(['Example dataset', 'Load from URL']);
    setStep('data_source');
    setReviewField(null);
    setReviewQueue([]);
    setPendingModality(null);
    setPendingEncField(null);
    setPendingEncProp(null);
    setSlotDataset(null);
    setSlotMark(null);
    setSlotFields(null);
    setSlotModality(null);
    setSlotEncodings([]);
    announce('Restarted.');
  };

  // ── Edit menu ─────────────────────────────────────────────────────────────

  const EDIT_OPTIONS = [
    'Change dataset', 'Change active fields', 'Change mark type',
    'Add encoding', 'Remove encoding', 'Change field type', 'Cancel edit',
  ];

  const openEditMenu = (returnTo: Step) => {
    setStepBeforeEdit(returnTo);
    push('agent', 'What would you like to edit?', EDIT_OPTIONS);
    setStep('edit_menu');
  };

  const handleEditMenu = (lower: string) => {
    if (/cancel|never mind|back|no/.test(lower)) {
      push('agent', 'No problem — chart is ready to use!',
        ['Edit something', 'Add more encodings', 'Summary', 'Restart']
      );
      setStep('done'); return;
    }
    if (/dataset|data/.test(lower)) {
      push('agent', `Available datasets: ${VEGA_DATASETS.join(', ')}.\nWhich one?`, VEGA_DATASETS);
      setStep('edit_dataset'); return;
    }
    if (/field/.test(lower) && !/type/.test(lower)) {
      push('agent',
        `Current active fields: ${activeFieldNames().join(', ')}.\nAll fields: ${spec.fields.map(f => f.name).join(', ')}.\n\nWhich fields do you want active?`,
        ['all', ...spec.fields.map(f => f.name).slice(0, 4)]
      );
      setStep('edit_fields'); return;
    }
    if (/mark/.test(lower)) {
      const units = spec.visual.units;
      if (!units.length) { push('agent', 'No visual units to edit.', EDIT_OPTIONS); return; }
      push('agent',
        `Visual units: ${units.map(u => `"${u.name}" (${u.mark})`).join(', ')}.\nSay the unit name and new mark type.`,
        units.map(u => u.name)
      );
      setStep('edit_mark'); return;
    }
    if (/add.*encod|encod/.test(lower) && !/remove/.test(lower)) {
      push('agent', encodingPrompt(), activeFieldNames().slice(0, 3).map(f => `encode ${f} as x`));
      setStep('edit_encoding_add'); return;
    }
    if (/remove.*encod|delete.*encod/.test(lower)) {
      const existing = allUnits().flatMap(u => {
        const unitSpec = u.type === 'visual'
          ? spec.visual.units.find(v => v.name === u.name)
          : spec.audio.units.find(a => a.name === u.name);
        return Object.entries(unitSpec?.encoding ?? {})
          .filter(([, v]) => v?.field)
          .map(([ch, v]) => `${v!.field} from ${ch}`);
      });
      push('agent',
        `Current encodings: ${existing.length ? existing.join(', ') : 'none'}.\nSay "remove <field> from <channel>".`,
        existing.slice(0, 4)
      );
      setStep('edit_encoding_remove'); return;
    }
    if (/type/.test(lower)) {
      push('agent',
        `Fields: ${activeFieldNames().join(', ')}.\nSay "<field> is <type>" (types: ${MEASURE_TYPES.join(', ')}).`,
        activeFieldNames().slice(0, 3).map(f => `${f} is quantitative`)
      );
      setStep('edit_type'); return;
    }
    push('agent', 'Not sure what to edit. Choose one:', EDIT_OPTIONS);
  };

  // ── Data loading ──────────────────────────────────────────────────────────

  const onDataReady = () => {
    setTimeout(() => {
      const names = spec.fields.map(f => f.name);

      // ── Fast path: user described a chart upfront ─────────────────────────
      // If a mark type was mentioned, use Vega-Lite heuristics to auto-select
      // fields and encodings, then ask the user if they want to change anything.
      const mark = slotMark();
      if (mark) {
        // Activate slot fields if specified, otherwise all fields
        const preFields = slotFields();
        const fieldsToActivate = (preFields && preFields.filter(f => names.includes(f)).length)
          ? preFields.filter(f => names.includes(f))
          : names;
        spec.fields.forEach(f => specActions.setFieldActive(f.name, fieldsToActivate.includes(f.name)));

        // Run Vega-Lite heuristic to pick x and y
        const defaults = inferDefaultFields();

        if (defaults) {
          const mod = slotModality() ?? 'visual';
          setPendingModality(mod);
          setSlotModality(null);

          // Create visual unit and set mark
          specActions.addVisualUnit();
          const vUnit = spec.visual.units[spec.visual.units.length - 1]?.name;
          if (vUnit) specActions.changeMark(vUnit, mark as any);
          if (mod === 'both') specActions.addAudioUnit();
          setSlotMark(null);
          setSlotFields(null);

          // Apply x and y encodings using inferred defaults
          if (vUnit) {
            specActions.addEncoding(defaults.xField, 'x', vUnit);
            specActions.addEncoding(defaults.yField, 'y', vUnit);
          }

          // Apply any additional encodings user mentioned (e.g. color)
          const extraEncs = slotEncodings().filter(
            e => e.field !== defaults.xField && e.field !== defaults.yField
          );
          for (const enc of extraEncs) {
            const candidates = allUnits().filter(u =>
              (isVisualProp(enc.channel) && u.type === 'visual') ||
              (isAudioProp(enc.channel) && u.type === 'audio')
            );
            if (candidates.length) specActions.addEncoding(enc.field, enc.channel, candidates[0].name);
          }
          setSlotEncodings([]);

          // Get field types for the confirmation message
          const xType = spec.fields.find(f => f.name === defaults.xField)?.type ?? '';
          const yType = spec.fields.find(f => f.name === defaults.yField)?.type ?? '';

          // Tell the user what was created and ask if they want to change anything
          push('agent',
            `Done! I've created a "${mark}" chart using:\n` +
            `  • x = ${defaults.xField} (${xType})\n` +
            `  • y = ${defaults.yField} (${yType})\n\n` +
            `Would you like to change anything?`,
            ['Looks good, done!', 'Change mark type', 'Change x field', 'Change y field', 'Add another encoding', 'Change dataset']
          );
          setStep('edit_menu');
          return;
        }
      }

      // ── Standard path: user gave us pre-specified fields ──────────────────
      const preFields = slotFields();
      if (preFields && preFields.length) {
        const validFields = preFields.filter(f => names.includes(f));
        if (validFields.length) {
          spec.fields.forEach(f => specActions.setFieldActive(f.name, validFields.includes(f.name)));
          push('agent',
            `Data loaded! Auto-selected fields you mentioned: ${validFields.join(', ')}.\nWould you like visual, audio, or both?`,
            ['Visual', 'Audio', 'Both']
          );
          setSlotFields(null);
          setStep('modality');
          return;
        }
      }

      // ── Slow path: ask the user ───────────────────────────────────────────
      // Still show a type-based suggestion as a chip so users can pick quickly
      const defaults = inferDefaultFields();
      const suggestionChip = defaults
        ? `${defaults.xField} and ${defaults.yField}`
        : null;

      push('agent',
        `Data loaded! Fields: ${names.join(', ')}.\n\n` +
        `Which fields would you like to use? Say "all", "all but X", or list them.` +
        (suggestionChip ? `\n\nSuggested based on field types: ${suggestionChip}` : ''),
        [
          ...(suggestionChip ? [suggestionChip] : []),
          'all',
          ...names.slice(0, 3),
        ]
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

  // ── Field review ──────────────────────────────────────────────────────────

  const startFieldReview = (fields: string[]) => {
    if (!fields.length) { push('agent', encodingPrompt()); setStep('encoding'); return; }
    setReviewQueue(fields.slice(1));
    setReviewField(fields[0]);
    const fieldDef = spec.fields.find(fd => fd.name === fields[0]);
    push('agent',
      `Reviewing field "${fields[0]}" — current type: ${fieldDef?.type ?? 'unknown'}.\nUpdate type, update encoding, or skip?`,
      ['Update type', 'Update encoding', 'Skip', 'Skip all']
    );
    setStep('field_review');
  };

  const nextFieldReview = () => {
    const queue = reviewQueue();
    if (!queue.length) {
      push('agent', encodingPrompt(), activeFieldNames().slice(0, 3).map(f => `encode ${f} as x`));
      setStep('encoding'); return;
    }
    const next = queue[0];
    setReviewQueue(queue.slice(1));
    setReviewField(next);
    const fieldDef = spec.fields.find(fd => fd.name === next);
    push('agent',
      `Reviewing field "${next}" — current type: ${fieldDef?.type ?? 'unknown'}.\nUpdate type, update encoding, or skip?`,
      ['Update type', 'Update encoding', 'Skip', 'Skip all']
    );
  };

  const applySlotEncodings = (): boolean => {
    const encs = slotEncodings();
    if (!encs.length) return false;
    const applied: string[] = [];
    for (const enc of encs) {
      const candidates = allUnits().filter(u =>
        (isVisualProp(enc.channel) && u.type === 'visual') ||
        (isAudioProp(enc.channel) && u.type === 'audio')
      );
      if (candidates.length) {
        specActions.addEncoding(enc.field, enc.channel, candidates[0].name);
        applied.push(`"${enc.field}" → ${enc.channel}`);
      }
    }
    setSlotEncodings([]);
    if (applied.length) {
      push('agent',
        `Auto-applied encodings you mentioned: ${applied.join(', ')}.\n\n` + encodingPrompt(),
        activeFieldNames().slice(0, 3).map(f => `encode ${f} as y`)
      );
      return true;
    }
    return false;
  };

  // ── Global auto-chart command ─────────────────────────────────────────────
  // Runs the full Vega-Lite heuristic from anywhere mid-conversation.
  // Called when user says "make a bar chart", "create a line chart", etc.
  // Requires data to already be loaded.

  const doAutoChart = (mark: string): boolean => {
    if (!spec.data.name || !spec.fields.length) {
      push('agent', 'Please load a dataset first, then I can create the chart.', ['Example dataset', 'Load from URL']);
      return true;
    }

    // Activate all fields so inferDefaultFields has the full set to work with
    spec.fields.forEach(f => specActions.setFieldActive(f.name, true));

    const defaults = inferDefaultFields();
    if (!defaults) {
      push('agent',
        `I couldn't infer sensible default fields for a "${mark}" chart — the dataset may not have a mix of quantitative and categorical/temporal fields.\n\nPlease encode fields manually:`,
        activeFieldNames().slice(0, 3).map(f => `encode ${f} as x`)
      );
      setStep('encoding');
      return true;
    }

    // Clear any existing visual units and re-create cleanly
    for (const unit of [...spec.visual.units]) specActions.removeVisualUnit(unit.name);
    specActions.addVisualUnit();
    const vUnit = spec.visual.units[spec.visual.units.length - 1]?.name;
    if (vUnit) {
      specActions.changeMark(vUnit, mark as any);
      specActions.addEncoding(defaults.xField, 'x', vUnit);
      specActions.addEncoding(defaults.yField, 'y', vUnit);
    }

    setPendingModality('visual');
    setSlotMark(null);
    setSlotEncodings([]);

    const xType = spec.fields.find(f => f.name === defaults.xField)?.type ?? '';
    const yType = spec.fields.find(f => f.name === defaults.yField)?.type ?? '';

    push('agent',
      `Done! Created a "${mark}" chart using:\n` +
      `  • x = ${defaults.xField} (${xType})\n` +
      `  • y = ${defaults.yField} (${yType})\n\n` +
      `Would you like to change anything?`,
      ['Looks good, done!', 'Change mark type', 'Change x field', 'Change y field', 'Add another encoding']
    );
    setStep('edit_menu');
    return true;
  };

  // ── Global channel reassignment ───────────────────────────────────────────
  // Catches "change x to price", "set y to temperature", "make color symbol"
  // at any step when there is at least one visual unit.

  const handleChannelReassignment = (lower: string): boolean => {
    if (!spec.visual.units.length && !spec.audio.units.length) return false;

    // Patterns: "change x to price", "set y to horsepower", "make color symbol",
    //           "use date for x", "x should be date", "x = date"
    const patterns = [
      /(?:change|set|make|update|switch)\s+(.+?)\s+(?:to|as|=)\s+(.+)/,
      /(?:use|put)\s+(.+?)\s+(?:for|on|as)\s+(.+)/,
      /(.+?)\s+(?:should be|=)\s+(.+)/,
    ];

    for (const pat of patterns) {
      const m = lower.match(pat);
      if (!m) continue;

      // Try both orderings: "change x to price" and "change price to x"
      const a = m[1].trim(), b = m[2].trim();

      // Order 1: a is channel, b is field
      const chanFromA = resolveChannel(a);
      const fieldFromB = bestFieldMatch(b, spec.fields.map(f => f.name));
      if (chanFromA && fieldFromB) {
        return applyChannelReassignment(chanFromA, fieldFromB);
      }

      // Order 2: a is field, b is channel
      const fieldFromA = bestFieldMatch(a, spec.fields.map(f => f.name));
      const chanFromB = resolveChannel(b);
      if (fieldFromA && chanFromB) {
        return applyChannelReassignment(chanFromB, fieldFromA);
      }
    }

    return false;
  };

  const applyChannelReassignment = (channel: EncodingPropName, fieldName: string): boolean => {
    // Find the first unit that supports this channel type
    const unit = allUnits().find(u =>
      (isVisualProp(channel) && u.type === 'visual') ||
      (isAudioProp(channel) && u.type === 'audio')
    );
    if (!unit) {
      const needed = isVisualProp(channel) ? 'visual' : 'audio';
      push('agent', `No ${needed} unit found. Say "add ${needed} unit" first.`);
      return true;
    }

    // Activate the field if it isn't already
    specActions.setFieldActive(fieldName, true);

    // addEncoding replaces any existing encoding on that channel
    specActions.addEncoding(fieldName, channel, unit.name);

    push('agent',
      `Updated: ${channel} = ${fieldName}.\n\n${buildSummary()}`,
      ['Looks good, done!', 'Change another channel', 'Add encoding', 'Edit something']
    );
    // Stay on current step so user can keep making changes
    return true;
  };

  // ── Global intent detection ───────────────────────────────────────────────

  const handleGlobal = (lower: string): boolean => {
    if (/\brestart\b|start over|start again|reset|begin again/.test(lower)) {
      doRestart(); return true;
    }
    if (/\bsummary\b|what have i|what did i|where am i|show state|current state|what'?s set/.test(lower)) {
      push('agent', buildSummary(), ['Edit something', 'Continue', 'Restart']);
      return true;
    }

    // Global auto-chart: "make a bar chart", "create a line chart", "build a scatter plot"
    // Only fires when a mark type is present in the message
    const chartTrigger = /\b(?:make|create|build|generate|give me|show me|draw)\b/.test(lower);
    if (chartTrigger) {
      const mark = (markTypes as string[]).find(m => new RegExp(`\\b${m}\\b`).test(lower));
      if (mark) return doAutoChart(mark);
    }

    // Global channel reassignment: "change x to price", "set y to horsepower"
    // Run before the general edit handler so it doesn't open the full edit menu
    if (/change|set|make|update|switch|use|put/.test(lower)) {
      if (handleChannelReassignment(lower)) return true;
    }

    if (/\bedit\b|change|update|modify|undo|go back|fix/.test(lower) && step() !== 'edit_menu' && !step().startsWith('edit_')) {
      openEditMenu(step()); return true;
    }
    return false;
  };

  // ── Main handler ──────────────────────────────────────────────────────────

  const handleInput = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    push('user', text);
    setInputVal('');
    inputEl?.focus();
    const lower = text.toLowerCase();

    extractSlots(text, spec.fields.map(f => f.name));

    if (handleGlobal(lower)) return;

    switch (step()) {

      case 'data_source': {
        const urlM = text.match(/https?:\/\/\S+/);
        if (urlM) { push('agent', 'Fetching data. Please wait.'); loadUrl(urlM[0]); break; }

        const ds = slotDataset() ?? bestDatasetMatch(lower);
        if (ds) {
          push('agent', `Loading "${ds}". Please wait.`);
          setSlotDataset(null);
          loadVega(ds);
          break;
        }

        if (/\b1\b|example|dataset/.test(lower)) {
          push('agent', `Available example datasets:\n${VEGA_DATASETS.join(', ')}\n\nWhich one?`, VEGA_DATASETS);
          setStep('data_example_choice');
        } else if (/\b2\b|url|http/.test(lower)) {
          push('agent', 'Paste the URL to your JSON or CSV dataset.');
          setStep('data_url');
        } else {
          push('agent', 'What data would you like to use? Name a dataset (e.g. "cars") or paste a URL.', ['Example dataset', 'Load from URL']);
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

      case 'fields': {
        const allNames = spec.fields.map(f => f.name);
        const selected = parseFieldList(text, allNames);
        if (!selected.length) {
          push('agent',
            `No matching fields. Available: ${allNames.join(', ')}.\nTry "all", "all but X", or list names.`,
            ['all', ...allNames.slice(0, 4)]
          );
          break;
        }
        spec.fields.forEach(f => specActions.setFieldActive(f.name, selected.includes(f.name)));

        const mod = slotModality();
        if (mod) {
          setPendingModality(mod);
          setSlotModality(null);
          const mark = slotMark();
          if (mark && (mod === 'visual' || mod === 'both')) {
            push('agent', `Selected: ${selected.join(', ')}. Using "${mod}" with "${mark}" mark.`);
            specActions.addVisualUnit();
            const vUnit = spec.visual.units[spec.visual.units.length - 1]?.name;
            if (vUnit) specActions.changeMark(vUnit, mark as any);
            if (mod === 'both') specActions.addAudioUnit();
            setSlotMark(null);
            setReviewQueue(selected);
            setReviewField(null);
            push('agent', 'Review field types and encodings?', ['Yes, review fields', 'No, skip to encoding']);
            setStep('field_review');
          } else {
            push('agent', `Selected: ${selected.join(', ')}. Using "${mod}".`);
            if (mod === 'visual' || mod === 'both') {
              push('agent', `What mark type? Options: ${markTypes.join(', ')}.`, markTypes as string[]);
              setStep('visual_mark');
            } else {
              specActions.addAudioUnit();
              setReviewQueue(selected);
              setReviewField(null);
              push('agent', 'Added audio unit. Review field types and encodings?', ['Yes, review fields', 'No, skip to encoding']);
              setStep('field_review');
            }
          }
        } else {
          push('agent', `Selected: ${selected.join(', ')}.\nWould you like visual, audio, or both?`, ['Visual', 'Audio', 'Both']);
          setStep('modality');
        }
        break;
      }

      case 'modality': {
        const hasV = /visual/.test(lower), hasA = /audio/.test(lower), hasB = /both/.test(lower);
        const mod: 'visual' | 'audio' | 'both' = (hasB || (hasV && hasA)) ? 'both' : hasA ? 'audio' : 'visual';
        setPendingModality(mod);
        setSlotModality(null);

        if (mod === 'visual' || mod === 'both') {
          const mark = slotMark();
          if (mark) {
            push('agent', `Using "${mark}" mark.`);
            specActions.addVisualUnit();
            const vUnit = spec.visual.units[spec.visual.units.length - 1]?.name;
            if (vUnit) specActions.changeMark(vUnit, mark as any);
            if (mod === 'both') specActions.addAudioUnit();
            setSlotMark(null);
            setReviewQueue(activeFieldNames());
            setReviewField(null);
            push('agent',
              `Added "${mark}" visual unit${mod === 'both' ? ' and audio unit' : ''}.\nReview field types and encodings?`,
              ['Yes, review fields', 'No, skip to encoding']
            );
            setStep('field_review');
          } else {
            push('agent', `What mark type? Options: ${markTypes.join(', ')}.`, markTypes as string[]);
            setStep('visual_mark');
          }
        } else {
          specActions.addAudioUnit();
          setReviewQueue(activeFieldNames());
          setReviewField(null);
          push('agent', 'Added audio unit. Review field types and encodings?', ['Yes, review fields', 'No, skip to encoding']);
          setStep('field_review');
        }
        break;
      }

      case 'visual_mark': {
        const mark = (markTypes as string[]).find(m => lower.includes(m));
        if (!mark) { push('agent', `Please choose: ${markTypes.join(', ')}.`, markTypes as string[]); break; }
        specActions.addVisualUnit();
        const vUnit = spec.visual.units[spec.visual.units.length - 1]?.name;
        if (vUnit) specActions.changeMark(vUnit, mark as any);
        if (pendingModality() === 'both') specActions.addAudioUnit();
        setSlotMark(null);
        setReviewQueue(activeFieldNames());
        setReviewField(null);
        push('agent',
          `Added "${mark}" visual unit${pendingModality() === 'both' ? ' and audio unit' : ''}.\nReview field types and encodings?`,
          ['Yes, review fields', 'No, skip to encoding']
        );
        setStep('field_review');
        break;
      }

      case 'field_review': {
        if (reviewField() === null) {
          if (/yes|review/.test(lower)) startFieldReview(reviewQueue());
          else {
            if (!applySlotEncodings()) push('agent', encodingPrompt(), activeFieldNames().slice(0, 3).map(f => `encode ${f} as x`));
            setStep('encoding');
          }
          break;
        }
        if (/skip all|no more|done reviewing/.test(lower)) {
          if (!applySlotEncodings()) push('agent', encodingPrompt(), activeFieldNames().slice(0, 3).map(f => `encode ${f} as x`));
          setStep('encoding'); break;
        }
        if (/skip/.test(lower)) { nextFieldReview(); break; }
        if (/type/.test(lower)) {
          push('agent', `Choose a type for "${reviewField()}": ${MEASURE_TYPES.join(', ')}.`, MEASURE_TYPES);
          setStep('field_review_type'); break;
        }
        if (/encod/.test(lower)) {
          const channels = pendingModality() === 'audio'
            ? (audioPropNames as readonly string[])
            : (visualPropNames as readonly string[]);
          push('agent', `Choose a channel for "${reviewField()}": ${channels.join(', ')}.`, channels.slice(0, 5) as string[]);
          setStep('field_review_enc'); break;
        }
        push('agent', 'Say "update type", "update encoding", "skip", or "skip all".', ['Update type', 'Update encoding', 'Skip', 'Skip all']);
        break;
      }

      case 'field_review_type': {
        const mtype = resolveMeasureType(lower);
        if (mtype && reviewField()) {
          specActions.setFieldType(reviewField()!, mtype);
          push('agent', `Set "${reviewField()}" to ${mtype}. Update encoding too?`, ['Yes, update encoding', 'Skip', 'Skip all']);
          setStep('field_review');
        } else {
          push('agent', `Choose one: ${MEASURE_TYPES.join(', ')}.`, MEASURE_TYPES);
        }
        break;
      }

      case 'field_review_enc': {
        const prop = resolveChannel(lower);
        if (prop && reviewField()) {
          const candidates = allUnits().filter(u =>
            (isVisualProp(prop) && u.type === 'visual') || (isAudioProp(prop) && u.type === 'audio')
          );
          if (candidates.length) {
            specActions.addEncoding(reviewField()!, prop, candidates[0].name);
            push('agent', `Encoded "${reviewField()}" as ${prop}.`, ['Skip', 'Skip all']);
          } else {
            push('agent', 'No matching unit for that channel.');
          }
          setStep('field_review');
          nextFieldReview();
        } else {
          const channels = pendingModality() === 'audio'
            ? (audioPropNames as readonly string[])
            : (visualPropNames as readonly string[]);
          push('agent', `Choose a channel: ${channels.join(', ')}.`, channels.slice(0, 5) as string[]);
        }
        break;
      }

      case 'encoding': {
        if (/\bdone\b|finish|that'?s?\s*it|no more|stop|looks good/.test(lower)) {
          push('agent', 'All done!\n\n' + buildSummary(), ['Edit something', 'Restart']);
          setStep('done'); break;
        }
        if (/add visual unit|new visual unit/.test(lower)) {
          specActions.addVisualUnit();
          const u = spec.visual.units[spec.visual.units.length - 1]?.name;
          push('agent', `Added visual unit "${u}". Choose mark: ${markTypes.join(', ')}.`, markTypes as string[]);
          setStep('visual_mark'); break;
        }
        if (/add audio unit|new audio unit/.test(lower)) {
          specActions.addAudioUnit();
          push('agent', 'Added audio unit. Keep encoding or say "done".'); break;
        }
        const removeM = lower.match(/remove\s+(.+?)\s+(?:from\s+)?(.+)/);
        if (removeM) {
          const fieldName = bestFieldMatch(removeM[1], activeFieldNames());
          const prop = resolveChannel(removeM[2]);
          if (fieldName && prop) {
            const unit = allUnits().find(u =>
              u.type === 'visual'
                ? getVisualEncodingField(spec.visual.units as any, u.name, prop) === fieldName
                : getAudioEncodingField(spec.audio.units as any, u.name, prop) === fieldName
            );
            if (unit) { specActions.removeEncoding(fieldName, prop, unit.name); push('agent', `Removed "${fieldName}" from ${prop}.`, ['done']); break; }
          }
        }
        const enc = parseEncodeCommand(lower, activeFieldNames());
        if (enc) {
          const candidates = allUnits().filter(u =>
            (isVisualProp(enc.channel) && u.type === 'visual') || (isAudioProp(enc.channel) && u.type === 'audio')
          );
          if (!candidates.length) {
            const needed = isVisualProp(enc.channel) ? 'visual' : 'audio';
            push('agent', `No ${needed} unit found. Say "add ${needed} unit" first.`); break;
          }
          if (candidates.length > 1) {
            setPendingEncField(enc.field); setPendingEncProp(enc.channel);
            push('agent', `Which unit for "${enc.field}" → ${enc.channel}?\n${candidates.map(u => u.name).join(', ')}.`, candidates.map(u => u.name));
            setStep('encoding_which_unit'); break;
          }
          specActions.addEncoding(enc.field, enc.channel, candidates[0].name);
          push('agent',
            `Encoded "${enc.field}" as ${enc.channel} in "${candidates[0].name}".\n\n` + encodingPrompt(),
            activeFieldNames().filter(f => f !== enc.field).slice(0, 3).map(f => `encode ${f} as y`)
          ); break;
        }
        push('agent', encodingPrompt(), activeFieldNames().slice(0, 3).map(f => `encode ${f} as x`));
        break;
      }

      case 'encoding_which_unit': {
        const fieldName = pendingEncField(), prop = pendingEncProp();
        const unit = allUnits().find(u => u.name.toLowerCase().includes(lower));
        if (fieldName && prop && unit) {
          specActions.addEncoding(fieldName, prop, unit.name);
          setPendingEncField(null); setPendingEncProp(null);
          push('agent', `Encoded "${fieldName}" as ${prop} in "${unit.name}".\n\n` + encodingPrompt(), ['done']);
          setStep('encoding');
        } else {
          push('agent', `Didn't find that unit. Options: ${allUnits().map(u => u.name).join(', ')}.`, allUnits().map(u => u.name));
        }
        break;
      }

      // ── Edit steps ────────────────────────────────────────────────────────

      case 'edit_menu': handleEditMenu(lower); break;

      case 'edit_dataset': {
        const hit = bestDatasetMatch(lower);
        if (hit) { push('agent', `Loading "${hit}". Please wait.`); loadVega(hit); }
        else push('agent', `Didn't recognise that. Options:\n${VEGA_DATASETS.join(', ')}.`, VEGA_DATASETS);
        break;
      }

      case 'edit_fields': {
        const selected = parseFieldList(text, spec.fields.map(f => f.name));
        if (!selected.length) {
          push('agent', `No matching fields. Available: ${spec.fields.map(f => f.name).join(', ')}.`, ['all']);
          break;
        }
        spec.fields.forEach(f => specActions.setFieldActive(f.name, selected.includes(f.name)));
        push('agent', `Active fields updated to: ${selected.join(', ')}.`, ['Edit something', 'Continue', 'Done']);
        setStep(stepBeforeEdit());
        break;
      }

      case 'edit_mark': {
        const unit = spec.visual.units.find(u => lower.includes(norm(u.name)));
        const mark = (markTypes as string[]).find(m => lower.includes(m));
        if (unit && mark) {
          specActions.changeMark(unit.name, mark as any);
          push('agent', `Changed "${unit.name}" mark to ${mark}.`, ['Edit something', 'Looks good, done!']);
          setStep(stepBeforeEdit());
        } else if (!unit) {
          push('agent', `Couldn't find that unit. Units: ${spec.visual.units.map(u => u.name).join(', ')}.`, spec.visual.units.map(u => u.name));
        } else {
          push('agent', `Couldn't find that mark type. Options: ${markTypes.join(', ')}.`, markTypes as string[]);
        }
        break;
      }

      case 'edit_encoding_add': {
        const enc = parseEncodeCommand(lower, activeFieldNames());
        if (enc) {
          const candidates = allUnits().filter(u =>
            (isVisualProp(enc.channel) && u.type === 'visual') || (isAudioProp(enc.channel) && u.type === 'audio')
          );
          if (candidates.length) {
            specActions.addEncoding(enc.field, enc.channel, candidates[0].name);
            push('agent', `Encoded "${enc.field}" as ${enc.channel}.`, ['Edit something', 'Add another encoding', 'Looks good, done!']);
            setStep(stepBeforeEdit());
          } else {
            push('agent', 'No matching unit. Add a visual or audio unit first.');
          }
        } else {
          push('agent', encodingPrompt(), activeFieldNames().slice(0, 3).map(f => `encode ${f} as x`));
        }
        break;
      }

      case 'edit_encoding_remove': {
        const removeM = lower.match(/remove\s+(.+?)\s+(?:from\s+)?(.+)/);
        if (removeM) {
          const fieldName = bestFieldMatch(removeM[1], activeFieldNames());
          const prop = resolveChannel(removeM[2]);
          if (fieldName && prop) {
            const unit = allUnits().find(u =>
              u.type === 'visual'
                ? getVisualEncodingField(spec.visual.units as any, u.name, prop) === fieldName
                : getAudioEncodingField(spec.audio.units as any, u.name, prop) === fieldName
            );
            if (unit) {
              specActions.removeEncoding(fieldName, prop, unit.name);
              push('agent', `Removed "${fieldName}" from ${prop}.`, ['Edit something', 'Looks good, done!']);
              setStep(stepBeforeEdit()); break;
            }
          }
        }
        push('agent', 'Say "remove <field> from <channel>", e.g. "remove price from x".');
        break;
      }

      case 'edit_type': {
        const typeM = lower.match(/^(.+?)\s+(?:is|as|to|=)\s+(.+)$/);
        if (typeM) {
          const fieldName = bestFieldMatch(typeM[1], activeFieldNames());
          const mtype = resolveMeasureType(typeM[2]);
          if (fieldName && mtype) {
            specActions.setFieldType(fieldName, mtype);
            push('agent', `Set "${fieldName}" to ${mtype}.`, ['Edit something', 'Looks good, done!']);
            setStep(stepBeforeEdit()); break;
          }
        }
        push('agent',
          `Say "<field> is <type>". Fields: ${activeFieldNames().join(', ')}. Types: ${MEASURE_TYPES.join(', ')}.`,
          activeFieldNames().slice(0, 3).map(f => `${f} is quantitative`)
        );
        break;
      }

      case 'done':
        // After auto-creation the user might say "looks good" or ask to change something
        if (/looks good|done|finish|great|perfect|yes/.test(lower)) {
          push('agent', 'Great! Your chart is ready. Say "edit" anytime to make changes.',
            ['Edit something', 'Summary', 'Restart']
          );
        } else {
          push('agent', 'Chart is configured. Say "edit" to change something, "summary" to review, or "restart" to start over.',
            ['Edit something', 'Summary', 'Restart']
          );
        }
        break;
    }
  };

  // ── Speech ────────────────────────────────────────────────────────────────

  const startListening = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { push('agent', 'Speech recognition not supported. Please use Chrome.'); return; }
    const rec = new SR();
    rec.lang = 'en-US'; rec.interimResults = false; rec.maxAlternatives = 1;
    setListening(true);
    announce('Listening. Speak your message.');
    rec.start();
    rec.onresult = (e: any) => handleInput(e.results[0][0].transcript);
    rec.onerror = (e: any) => {
      setListening(false);
      const msgs: Record<string, string> = {
        network: 'Network error. Check your connection.',
        'not-allowed': 'Microphone access denied. Allow it in your browser settings.',
        'no-speech': 'No speech detected. Please try again.',
        'audio-capture': 'No microphone found.',
      };
      push('agent', msgs[e.error] ?? `Speech error: ${e.error}. Please type instead.`);
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
            aria-label={listening() ? 'Listening — microphone active' : 'Start voice input'}
            aria-pressed={listening()}
          >
            <span aria-hidden="true">🎤</span>
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
        Try describing your whole chart at once — e.g. "bar chart of weather data" or "line chart of stocks".
        Say "summary" to review, "edit" to change something, or "restart" to begin again.
      </p>
    </div>
  );
}