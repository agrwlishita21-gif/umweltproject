import { createSignal, For } from 'solid-js';
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

// ── Constants ─────────────────────────────────────────────────────────────────

const VEGA_DATASETS = [
  'stocks.csv', 'cars.json', 'weather.csv', 'seattle-weather.csv',
  'penguins.json', 'driving.json', 'barley.json', 'disasters.csv', 'gapminder.json',
];

const MEASURE_TYPES: MeasureType[] = ['quantitative', 'ordinal', 'nominal', 'temporal'];

const CHANNEL_ALIASES: Record<string, EncodingPropName> = {
  x: 'x', 'x axis': 'x', 'x-axis': 'x', horizontal: 'x', 'h axis': 'x',
  y: 'y', 'y axis': 'y', 'y-axis': 'y', vertical: 'y', 'v axis': 'y',
  color: 'color', colour: 'color', hue: 'color',
  shape: 'shape', mark: 'shape',
  size: 'size', radius: 'size',
  opacity: 'opacity', transparency: 'opacity', alpha: 'opacity',
  pitch: 'pitch', frequency: 'pitch', freq: 'pitch', note: 'pitch',
  volume: 'volume', loudness: 'volume', amplitude: 'volume',
  duration: 'duration', length: 'duration',
};

const TYPE_ALIASES: Record<string, MeasureType> = {
  quantitative: 'quantitative', quant: 'quantitative', numeric: 'quantitative', number: 'quantitative', continuous: 'quantitative',
  ordinal: 'ordinal', ordered: 'ordinal', ranked: 'ordinal',
  nominal: 'nominal', categorical: 'nominal', category: 'nominal', discrete: 'nominal',
  temporal: 'temporal', time: 'temporal', date: 'temporal', datetime: 'temporal', dates: 'temporal',
};

// ── Fuzzy field matching ──────────────────────────────────────────────────────

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
  if (overlap > 0) return 20 + overlap * 10;
  return 0;
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

// ── Typed encoding lookup helpers ─────────────────────────────────────────────
// These replace `encoding[prop as any]` to satisfy TypeScript's index checks.

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

// FIX: renamed prop from 'role' to 'msgrole' to avoid conflict with HTML role attribute (ts2322)
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

// ── Component ─────────────────────────────────────────────────────────────────

export function ConversationAgent() {
  const [spec, specActions] = useUmweltSpec();
  const [, datastoreActions] = useUmweltDatastore();

  let msgId = 0;
  const mk = (role: Role, text: string): Message => ({ role, text, id: msgId++ });

  const [messages, setMessages] = createSignal<Message[]>([
    mk('agent', 'Hi! What data would you like to use?\n1. An example dataset\n2. Load from a URL'),
  ]);
  const [step, setStep] = createSignal<Step>('data_source');
  const [input, setInput] = createSignal('');
  const [listening, setListening] = createSignal(false);
  const [suggestions, setSuggestions] = createSignal<string[]>(['1. Example dataset', '2. Load from URL']);
  const [liveMsg, setLiveMsg] = createSignal('');

  const [reviewQueue, setReviewQueue] = createSignal<string[]>([]);
  const [reviewField, setReviewField] = createSignal<string | null>(null);

  const [pendingModality, setPendingModality] = createSignal<'visual' | 'audio' | 'both' | null>(null);
  const [pendingEncField, setPendingEncField] = createSignal<string | null>(null);
  const [pendingEncProp, setPendingEncProp] = createSignal<EncodingPropName | null>(null);

  const [stepBeforeEdit, setStepBeforeEdit] = createSignal<Step>('encoding');

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
    if (role === 'agent') announce(text + (chips.length ? ` Suggested options: ${chips.join(', ')}.` : ''));
  };

  const activeFields = () => spec.fields.filter(f => f.active);
  const activeFieldNames = () => activeFields().map(f => f.name);

  const allUnits = () => [
    ...spec.visual.units.map(u => ({ name: u.name, type: 'visual' as const })),
    ...spec.audio.units.map(u => ({ name: u.name, type: 'audio' as const })),
  ];

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
    } else {
      lines.push('Visual units: none');
    }
    if (spec.audio.units.length) {
      for (const unit of spec.audio.units) {
        const encs = Object.entries(unit.encoding)
          .filter(([, v]) => v?.field)
          .map(([ch, v]) => `${ch} = ${v!.field}`)
          .join(', ');
        lines.push(`Audio unit "${unit.name}":${encs ? ` encodings: ${encs}` : ' no encodings'}`);
      }
    } else {
      lines.push('Audio units: none');
    }
    return lines.join('\n');
  };

  // ── Parse field lists ─────────────────────────────────────────────────────

  const parseFieldList = (text: string, pool: string[]): string[] => {
    const lower = text.toLowerCase().trim();
    if (/^all$|^everything$|^all fields$/.test(lower)) return pool;
    const exceptM = lower.match(
      /^(?:all|everything)(?:\s+(?:but|except|excluding|apart from|other than|minus))\s+(.+)$/
    );
    if (exceptM) {
      const parts = exceptM[1].split(/,\s*|\s+and\s+|\s*&\s*/).map(s => s.trim());
      return pool.filter(f => !parts.some(p => bestFieldMatch(p, [f])));
    }
    const parts = lower.split(/,\s*|\s+and\s+|\s*&\s*/).map(s => s.trim()).filter(Boolean);
    return pool.filter(f => parts.some(p => (bestFieldMatch(p, [f]) ?? '') === f || fieldMatchScore(p, f) > 0));
  };

  // ── Dataset matching ──────────────────────────────────────────────────────

  const bestDatasetMatch = (text: string): string | undefined => {
    const needle = norm(text);
    let bestScore = 0;
    let bestDataset: string | undefined;
    for (const d of VEGA_DATASETS) {
      const stem = norm(d.replace(/\.[^.]+$/, ''));
      if (needle.includes(stem) || stem.includes(needle)) {
        if (stem.length > bestScore) { bestScore = stem.length; bestDataset = d; }
      }
    }
    return bestDataset;
  };

  // ── Encode command parser ─────────────────────────────────────────────────

  const parseEncodeCommand = (lower: string): { field: string; prop: EncodingPropName } | null => {
    const patterns = [
      /(?:encode|map|set|assign|put|use|add)\s+(.+?)\s+(?:as|to|on|for|in|into)\s+(.+)/,
      /(.+?)\s+(?:as|to|on|onto)\s+(?:the\s+)?(.+?)\s*(?:axis|channel|field)?$/,
    ];
    for (const pat of patterns) {
      const m = lower.match(pat);
      if (m) {
        const spokenField = m[1].trim();
        const spokenChan = m[2].trim();
        const field = bestFieldMatch(spokenField, activeFieldNames());
        const prop = resolveChannel(spokenChan);
        if (field && prop) return { field, prop };
        if (field && !prop) return null;
      }
    }
    return null;
  };

  // ── Encoding prompt ───────────────────────────────────────────────────────

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
    setMessages([mk('agent', 'Restarting. What data would you like to use?\n1. An example dataset\n2. Load from a URL')]);
    setSuggestions(['1. Example dataset', '2. Load from URL']);
    setStep('data_source');
    setReviewField(null);
    setReviewQueue([]);
    setPendingModality(null);
    setPendingEncField(null);
    setPendingEncProp(null);
    announce('Restarted. What data would you like to use?');
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
    if (/cancel|never mind|back/.test(lower)) {
      push('agent', 'Edit cancelled. Continuing where you left off.');
      setStep(stepBeforeEdit()); return;
    }
    if (/dataset|data/.test(lower)) {
      push('agent', `Available datasets: ${VEGA_DATASETS.join(', ')}.\nWhich dataset would you like?`, VEGA_DATASETS);
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
      if (!units.length) { push('agent', 'No visual units to edit. Add one first.', EDIT_OPTIONS); return; }
      push('agent',
        `Visual units: ${units.map(u => `"${u.name}" (${u.mark})`).join(', ')}.\nSay the unit name and mark type, e.g. "unit1 bar".`,
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
      push('agent',
        `Data loaded! Fields: ${names.join(', ')}.\n\nWhich fields would you like to use? Say "all", "all but X", "everything except X and Y", or list them.`,
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
      if (data?.length) { datastoreActions.setDataset(filename, data, url); specActions.initializeData(filename); onDataReady(); }
      else push('agent', "Couldn't fetch data from that URL. Please check it and try again.");
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
    if (!queue.length) { push('agent', encodingPrompt(), activeFieldNames().slice(0, 3).map(f => `encode ${f} as x`)); setStep('encoding'); return; }
    const next = queue[0];
    setReviewQueue(queue.slice(1));
    setReviewField(next);
    const fieldDef = spec.fields.find(fd => fd.name === next);
    push('agent',
      `Reviewing field "${next}" — current type: ${fieldDef?.type ?? 'unknown'}.\nUpdate type, update encoding, or skip?`,
      ['Update type', 'Update encoding', 'Skip', 'Skip all']
    );
  };

  // ── Global intent detection ───────────────────────────────────────────────

  const handleGlobal = (lower: string): boolean => {
    if (/\brestart\b|start over|start again|reset|begin again/.test(lower)) {
      doRestart(); return true;
    }
    if (/\bsummary\b|what have i|what did i|where am i|show state|current state|what's set/.test(lower)) {
      push('agent', buildSummary(), ['Edit something', 'Continue', 'Restart']);
      return true;
    }
    if (/\bedit\b|change|update|modify|undo|go back|fix/.test(lower) && step() !== 'edit_menu' && !step().startsWith('edit_')) {
      openEditMenu(step());
      return true;
    }
    return false;
  };

  // ── Main handler ──────────────────────────────────────────────────────────

  const handleInput = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    push('user', text);
    setInput('');
    inputEl?.focus();
    const lower = text.toLowerCase();

    if (handleGlobal(lower)) return;

    switch (step()) {

      case 'data_source': {
        if (/\b1\b|example/.test(lower)) {
          push('agent', `Available example datasets: ${VEGA_DATASETS.join(', ')}.\nWhich one?`, VEGA_DATASETS);
          setStep('data_example_choice');
        } else if (/\b2\b|url|http/.test(lower)) {
          push('agent', 'Paste the URL to your JSON or CSV dataset.');
          setStep('data_url');
        } else {
          push('agent', 'Reply with 1 for example datasets, or 2 to load from a URL.', ['1. Example dataset', '2. Load from URL']);
        }
        break;
      }

      case 'data_example_choice': {
        const hit = bestDatasetMatch(lower);
        if (hit) { push('agent', `Loading "${hit}". Please wait.`); loadVega(hit); }
        else push('agent', `Didn't recognise that. Options: ${VEGA_DATASETS.join(', ')}.`, VEGA_DATASETS);
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
        push('agent', `Selected: ${selected.join(', ')}.\nWould you like visual, audio, or both?`, ['Visual', 'Audio', 'Both']);
        setStep('modality');
        break;
      }

      case 'modality': {
        const hasV = /visual/.test(lower), hasA = /audio/.test(lower), hasB = /both/.test(lower);
        const mod: 'visual' | 'audio' | 'both' = (hasB || (hasV && hasA)) ? 'both' : hasA ? 'audio' : 'visual';
        setPendingModality(mod);
        if (mod === 'visual' || mod === 'both') {
          push('agent', `What mark type? Options: ${markTypes.join(', ')}.`, markTypes as string[]);
          setStep('visual_mark');
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
          else { push('agent', encodingPrompt(), activeFieldNames().slice(0, 3).map(f => `encode ${f} as x`)); setStep('encoding'); }
          break;
        }
        if (/skip all|no more|done reviewing/.test(lower)) {
          push('agent', encodingPrompt(), activeFieldNames().slice(0, 3).map(f => `encode ${f} as x`));
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
        if (/\bdone\b|finish|that'?s?\s*it|no more|stop/.test(lower)) {
          push('agent', 'All done! ' + buildSummary());
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
            // FIX: use typed helpers instead of encoding[prop as any] (ts7053)
            const unit = allUnits().find(u =>
              u.type === 'visual'
                ? getVisualEncodingField(spec.visual.units as any, u.name, prop) === fieldName
                : getAudioEncodingField(spec.audio.units as any, u.name, prop) === fieldName
            );
            if (unit) { specActions.removeEncoding(fieldName, prop, unit.name); push('agent', `Removed "${fieldName}" from ${prop}.`, ['done']); break; }
          }
        }
        const enc = parseEncodeCommand(lower);
        if (enc) {
          const candidates = allUnits().filter(u =>
            (isVisualProp(enc.prop) && u.type === 'visual') || (isAudioProp(enc.prop) && u.type === 'audio')
          );
          if (!candidates.length) {
            const needed = isVisualProp(enc.prop) ? 'visual' : 'audio';
            push('agent', `No ${needed} unit found. Say "add ${needed} unit" first.`); break;
          }
          if (candidates.length > 1) {
            setPendingEncField(enc.field); setPendingEncProp(enc.prop);
            push('agent', `Which unit for "${enc.field}" → ${enc.prop}? ${candidates.map(u => u.name).join(', ')}.`, candidates.map(u => u.name));
            setStep('encoding_which_unit'); break;
          }
          specActions.addEncoding(enc.field, enc.prop, candidates[0].name);
          push('agent', `Encoded "${enc.field}" as ${enc.prop} in "${candidates[0].name}".\n\n` + encodingPrompt(),
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

      case 'edit_menu': handleEditMenu(lower); break;

      case 'edit_dataset': {
        const hit = bestDatasetMatch(lower);
        if (hit) { push('agent', `Loading "${hit}". Please wait.`); loadVega(hit); }
        else push('agent', `Didn't recognise that dataset. Options: ${VEGA_DATASETS.join(', ')}.`, VEGA_DATASETS);
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
          push('agent', `Changed "${unit.name}" mark to ${mark}.`, ['Edit something', 'Continue', 'Done']);
          setStep(stepBeforeEdit());
        } else if (!unit) {
          push('agent', `Couldn't find that unit. Units: ${spec.visual.units.map(u => u.name).join(', ')}.`, spec.visual.units.map(u => u.name));
        } else {
          push('agent', `Couldn't find that mark type. Options: ${markTypes.join(', ')}.`, markTypes as string[]);
        }
        break;
      }

      case 'edit_encoding_add': {
        const enc = parseEncodeCommand(lower);
        if (enc) {
          const candidates = allUnits().filter(u =>
            (isVisualProp(enc.prop) && u.type === 'visual') || (isAudioProp(enc.prop) && u.type === 'audio')
          );
          if (candidates.length) {
            specActions.addEncoding(enc.field, enc.prop, candidates[0].name);
            push('agent', `Encoded "${enc.field}" as ${enc.prop}.`, ['Edit something', 'Add another encoding', 'Done']);
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
            // FIX: use typed helpers instead of encoding[prop as any] (ts7053)
            const unit = allUnits().find(u =>
              u.type === 'visual'
                ? getVisualEncodingField(spec.visual.units as any, u.name, prop) === fieldName
                : getAudioEncodingField(spec.audio.units as any, u.name, prop) === fieldName
            );
            if (unit) {
              specActions.removeEncoding(fieldName, prop, unit.name);
              push('agent', `Removed "${fieldName}" from ${prop}.`, ['Edit something', 'Done']);
              setStep(stepBeforeEdit()); break;
            }
          }
        }
        push('agent', 'Say "remove <field> from <channel>", e.g. "remove Miles per Gallon from x".');
        break;
      }

      case 'edit_type': {
        const typeM = lower.match(/^(.+?)\s+(?:is|as|to|=)\s+(.+)$/);
        if (typeM) {
          const fieldName = bestFieldMatch(typeM[1], activeFieldNames());
          const mtype = resolveMeasureType(typeM[2]);
          if (fieldName && mtype) {
            specActions.setFieldType(fieldName, mtype);
            push('agent', `Set "${fieldName}" to ${mtype}.`, ['Edit something', 'Done']);
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
        push('agent', 'Chart is already configured. Say "edit" to change something, "summary" to review, or "restart" to start over.',
          ['Edit something', 'Summary', 'Restart']
        );
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
        network: 'Network error: Chrome cannot reach the speech server. Check your connection or VPN.',
        'not-allowed': 'Microphone access denied. Allow it in your browser settings.',
        'no-speech': 'No speech detected. Please try again.',
        'audio-capture': 'No microphone found. Please connect one and try again.',
      };
      push('agent', msgs[e.error] ?? `Speech error: ${e.error}. Please type instead.`);
    };
    rec.onend = () => setListening(false);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div role="tabpanel" id="tabpanel-conversationAgent" aria-labelledby="tab-conversationAgent">
      <h2>Conversational Agent</h2>

      {/* Hidden live region for screen reader announcements */}
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
              // FIX: use msgrole instead of role to avoid HTML attribute conflict (ts2322)
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
            value={input()}
            aria-label="Type your message"
            aria-describedby="chat-hint"
            onInput={e => setInput(e.currentTarget.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleInput(input()); }}
          />
          <IconBtn
            onClick={doRestart}
            aria-label="Restart conversation"
            title="Restart"
          >
            <span aria-hidden="true">↺</span>
          </IconBtn>
          <SendBtn
            onClick={() => handleInput(input())}
            disabled={!input().trim()}
            aria-label="Send message"
          >
            Send
          </SendBtn>
        </InputArea>
      </Wrap>

      <p id="chat-hint" style={{ 'font-size': '12px', color: '#666', margin: '4px 0 0' }}>
        Type and press Enter or Send. Use suggested reply buttons, or the microphone for voice input.
        Say "summary" at any time to review your choices, "edit" to change something, or "restart" to begin again.
      </p>
    </div>
  );
}