// The workspace — the screen you live in. Machines as chips across the top
// (one tap to jump boxes), the current box's projects always in sight (a
// sidebar on wide screens, a chip strip on phones), terminal filling the
// rest. Layout mirrors the web dashboard's always-visible sidebar instead of
// v1's list → list → terminal drill-down.
import { ElementType, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, FlatList, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View,
} from 'react-native';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import * as SecureStore from 'expo-secure-store';
import * as Speech from 'expo-speech';
import { setAudioModeAsync } from 'expo-audio';
import {
  ApiError, browseDir, BrowseEntry, ChatMsg as ChatMsgT, ChatStatus as ChatStatusT,
  claudeTranscript, createProject, deleteProject,
  getProjects, moveProject, Project, setProjectHidden, termBuffer, termCapture,
  termKey, termMouse, termPaste, termUrl, uploadFile,
} from '@/lib/api';
import { Box, loadBoxes, tokenAlive } from '@/lib/boxes';
import { splitHtml } from '@/lib/mdhtml';
import { splitMdTables } from '@/lib/mdtable';
import { C } from '@/lib/theme';
import { SelText, selTextAvailable } from '../../modules/tc-seltext';
import { DropEvent, TCDropZone } from '../../modules/tc-dropzone';

const KEYS: Array<{ label: string; key: string; wide?: boolean }> = [
  { label: '↑', key: 'up' }, { label: '↓', key: 'down' },
  { label: '←', key: 'left' }, { label: '→', key: 'right' },
  { label: 'Esc', key: 'esc' }, { label: '⇥', key: 'tab' },
  { label: '⇧⇥', key: 'btab', wide: true },
  { label: '^C', key: 'ctrl-c' }, { label: '⏎', key: 'enter' },
];

// TUI-footer wording for the transcript's permissionMode values
const modeLabel = (m?: string) => m === 'auto' ? '▶▶ auto mode'
  : m === 'acceptEdits' ? '⏵⏵ accept edits'
  : m === 'default' ? '⏵ default mode'
  : m === 'plan' ? '⏸ plan mode'
  : m === 'bypassPermissions' ? '⚡ bypass permissions'
  : m ?? '';
const fmtTokens = (t: number) =>
  t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);

// html chat segments render here: an embedded WebView sized to its content
// (capped — ⤢ opens the fullscreen modal for the rest). Bare fragments get
// wrapped in the app palette so they don't flash a white card; a full
// document keeps its own styling.
const HTML_WRAP =
  '<!doctype html><html><head><meta name="viewport" '
  + 'content="width=device-width,initial-scale=1"><style>'
  + `body{margin:0;background:${C.bg};color:${C.text};`
  + 'font-family:system-ui,-apple-system,sans-serif}'
  + '</style></head><body>';
const HTML_MEASURE =
  '(function(){var p=function(){window.ReactNativeWebView.postMessage('
  + 'String(document.documentElement.scrollHeight))};'
  + 'window.addEventListener("load",p);setTimeout(p,60);setTimeout(p,400);'
  + '})();true;';
const INLINE_HTML_MAX = 420;

function InlineHtml({ html, onExpand }: { html: string; onExpand: () => void }) {
  const [h, setH] = useState(160);
  const doc = /^\s*(<!doctype|<html)/i.test(html)
    ? html : HTML_WRAP + html + '</body></html>';
  return (
    <View style={s.inlineHtml}>
      <WebView
        source={{ html: doc }}
        style={{ height: Math.min(h, INLINE_HTML_MAX), backgroundColor: C.bg }}
        scrollEnabled={false}
        injectedJavaScript={HTML_MEASURE}
        onMessage={(e) => {
          const n = Number(e.nativeEvent.data);
          if (n > 0) setH(n);
        }}
        setSupportMultipleWindows={false}
        allowsLinkPreview={false}
        originWhitelist={['*']}
      />
      <Pressable style={s.htmlExpand} onPress={onExpand}>
        <Text style={s.htmlChipText}>
          {h > INLINE_HTML_MAX ? '⤢ Full screen — clipped here' : '⤢ Full screen'}
        </Text>
      </Pressable>
    </View>
  );
}

export default function Workspace() {
  const params = useLocalSearchParams<{ box?: string; project?: string }>();
  // SafeAreaView doesn't reliably apply insets inside a <Modal> on iOS (the
  // provider sits outside the modal's native tree) — grab the numbers and
  // pad modals by hand
  const insets = useSafeAreaInsets();
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [boxId, setBoxId] = useState<string | undefined>(params.box);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsRoot, setProjectsRoot] = useState('');
  const [projectId, setProjectId] = useState<string | undefined>(params.project);
  const [status, setStatus] = useState<'connecting' | 'up' | 'down'>('connecting');
  const [showHidden, setShowHidden] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [dictText, setDictText] = useState('');
  const [htmlPreview, setHtmlPreview] = useState<string | null>(null);
  // composer height is pinned to measured content — iOS multiline inputs
  // otherwise balloon to maxHeight on focus even when empty
  const [composerH, setComposerH] = useState(0);
  const [kbUp, setKbUp] = useState(false);
  useEffect(() => {
    const ios = Platform.OS === 'ios';
    const show = Keyboard.addListener(
      ios ? 'keyboardWillShow' : 'keyboardDidShow', () => setKbUp(true));
    const hide = Keyboard.addListener(
      ios ? 'keyboardWillHide' : 'keyboardDidHide', () => setKbUp(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const web = useRef<WebView>(null);
  const lastSel = useRef('');
  const wide = useWindowDimensions().width >= 700;

  const box = boxes.find((b) => b.id === boxId);
  const project = projects.find((p) => p.id === projectId);
  const visible = projects.filter((p) => !p.hidden);
  const hidden = projects.filter((p) => p.hidden);
  // NOTE: no kept-alive webview pool here — tried it for instant tab
  // switching and it backfired: iOS suspends hidden WebViews (wedged app on
  // re-show), and the extra tmux clients from other devices shrank every
  // session to the smallest screen. One live terminal at a time; the asset
  // cache keeps switches cheap.

  // sidebar/tab zoom for big monitors — 5 steps, persisted per device
  const ZOOMS = [0.85, 1, 1.15, 1.35, 1.6];
  const [zoomI, setZoomI] = useState(1);
  useEffect(() => {
    void SecureStore.getItemAsync('tc.tabZoom').then((r) => {
      const i = r ? parseInt(r, 10) : NaN;
      if (!Number.isNaN(i) && i >= 0 && i < ZOOMS.length) setZoomI(i);
    });
  }, []);
  const bumpZoom = (d: number) => {
    const i = Math.max(0, Math.min(ZOOMS.length - 1, zoomI + d));
    setZoomI(i);
    void SecureStore.setItemAsync('tc.tabZoom', String(i));
  };
  const Z = ZOOMS[zoomI];

  // chat text size — Aa in the chat bar cycles 4 steps, persisted per device
  const CHAT_SIZES = [12, 14, 17, 20];
  const [chatSizeI, setChatSizeI] = useState(0);
  useEffect(() => {
    void SecureStore.getItemAsync('tc.chatSize').then((r) => {
      const i = r ? parseInt(r, 10) : NaN;
      if (!Number.isNaN(i) && i >= 0 && i < CHAT_SIZES.length) setChatSizeI(i);
    });
  }, []);
  const chatFs = CHAT_SIZES[chatSizeI];
  const cycleChatSize = () => {
    const i = (chatSizeI + 1) % CHAT_SIZES.length;
    setChatSizeI(i);
    void SecureStore.setItemAsync('tc.chatSize', String(i));
  };

  // dynamic tab spacing: rows stretch to fill the sidebar, redistributing
  // when tabs are hidden/added — clamped so few tabs don't balloon and many
  // tabs still scroll
  const [sideH, setSideH] = useState(0);

  // last-opened project per box — switching machines (or relaunching the
  // app) drops you back on the tab you left, not the first one
  const lastByBox = useRef<Record<string, string>>({});
  const [prefsReady, setPrefsReady] = useState(false);
  useEffect(() => {
    void SecureStore.getItemAsync('tc.lastProjects').then((raw) => {
      if (raw) { try { lastByBox.current = JSON.parse(raw); } catch { /* fresh */ } }
      setPrefsReady(true);
    });
  }, []);
  useEffect(() => {
    if (!boxId || !projectId) return;
    lastByBox.current[boxId] = projectId;
    void SecureStore.setItemAsync('tc.lastProjects', JSON.stringify(lastByBox.current));
  }, [boxId, projectId]);

  useFocusEffect(useCallback(() => {
    void loadBoxes().then((bs) => {
      setBoxes(bs);
      if (!boxId && bs.length) setBoxId(bs[0].id);
    });
  }, [boxId]));

  // box-switch speedups: keep every box's last-known project list and every
  // tab's chat state in memory. Switching renders the cached view instantly
  // and refreshes in the background instead of tearing down to "Loading…".
  const projCache = useRef<Record<string, Project[]>>({});
  const chatCache = useRef<Record<string,
    { msgs: ChatMsgT[]; since: string; avail: boolean | null;
      status?: ChatStatusT }>>({});

  const loadProjects = useCallback(() => {
    if (!box) return Promise.resolve();
    const bid = box.id;
    return getProjects(box).then((d) => {
      if (!Array.isArray(d.projects)) return;   // gate page / odd server reply
      projCache.current[bid] = d.projects;
      setProjects(d.projects);
      setProjectsRoot(d.projects_root ?? '');
      setProjectId((cur) => {
        if (cur && d.projects.some((p) => p.id === cur)) return cur;
        const remembered = lastByBox.current[bid];
        if (remembered && d.projects.some((p) => p.id === remembered)) return remembered;
        return d.projects.find((p) => !p.hidden)?.id;
      });
    }).catch(() => { /* poll again; terminal itself shows real failures */ });
  }, [box?.id, box?.token]);

  // load (and lightly poll) the selected box's projects
  useEffect(() => {
    if (!box || !prefsReady) return;
    void loadProjects();
    const t = setInterval(() => void loadProjects(), 15000);
    return () => clearInterval(t);
  }, [loadProjects, prefsReady]);

  // warm the OTHER boxes' project lists in the background so a first switch
  // has data waiting (the Pis are an ocean away — hide the RTT, don't pay it)
  const boxesKey = boxes.map((b) => b.id).join(',');
  useEffect(() => {
    if (!boxes.length) return;
    const warm = () => boxes.forEach((b) => {
      if (b.id !== boxId && tokenAlive(b)) {
        void getProjects(b)
          .then((d) => { projCache.current[b.id] = d.projects; })
          .catch(() => { /* offline box — nothing to warm */ });
      }
    });
    warm();
    const t = setInterval(warm, 60000);
    return () => clearInterval(t);
  }, [boxesKey, boxId]);

  // 💬 chat view — the session's Claude conversation read from the transcript
  // file Claude Code already writes on the server: real message objects, not
  // screen-scraping. Incremental polling (only new bytes), a virtualized list
  // (no iOS long-text ceiling), native scrolling/selection, long-press any
  // message to copy it whole. Input still rides the server's send-keys/paste
  // endpoints. Phones default to chat; wide screens to the live terminal.
  // Tabs with no transcript (ssh boxes, plain shells) fall back to terminal.
  const [chatPref, setChatPref] = useState<string | null>(null);
  useEffect(() => {
    void SecureStore.getItemAsync('tc.reader').then(setChatPref);
  }, []);
  const chatOn = chatPref === '1' || (chatPref !== '0' && !wide);
  const toggleChat = () => {
    const next = chatOn ? '0' : '1';
    setChatPref(next);
    void SecureStore.setItemAsync('tc.reader', next);
    setStatus('connecting');
  };
  const [chatMsgs, setChatMsgs] = useState<ChatMsgT[]>([]);
  const [chatAvail, setChatAvail] = useState<boolean | null>(null);
  // session status (permission mode + context size) for the strip above the
  // composer; ref mirrors state so cache writes always see the latest
  const [chatStatus, setChatStatus] = useState<ChatStatusT>({});
  const chatStat = useRef<ChatStatusT>({});
  const chatSince = useRef('');
  const chatActive = chatOn && chatAvail !== false;
  useEffect(() => {
    if (!chatOn || !box || !projectId) return;
    const b = box, pid = projectId;
    const key = `${b.id}:${pid}`;
    // seed from cache: revisiting a tab shows its conversation immediately
    // and the poll catches up incrementally from the saved cursor. Keyed on
    // projectId (not the project object) so the first pull races the
    // project-list fetch after a box switch instead of queuing behind it.
    const cached = chatCache.current[key];
    setChatMsgs(cached?.msgs ?? []);
    setChatAvail(cached?.avail ?? null);
    chatStat.current = cached?.status ?? {};
    setChatStatus(chatStat.current);
    chatSince.current = cached?.since ?? '';
    let live = true;
    const pull = async () => {
      try {
        const r = await claudeTranscript(b, pid, chatSince.current);
        if (!live) return;
        if (r.session === null) {
          setChatAvail(false);
          chatCache.current[key] = { msgs: [], since: '', avail: false };
          return;
        }
        setChatAvail(true);
        const first = chatSince.current === '';
        chatSince.current = `${r.session}:${r.offset}`;
        // merge status: an incremental pull with no news sends {} — keep the
        // last-known values; a reset (new/cleared session) starts over
        const st = r.status ?? {};
        chatStat.current = (first || r.reset) ? st
          : { ...chatStat.current, ...st };
        setChatStatus(chatStat.current);
        if (r.messages.length || r.reset) {
          // auto-speak: voice each newly-arrived reply, never the backlog a
          // first load / session reset brings in
          if (!first && !r.reset && autoSpeakRef.current) {
            const said = r.messages.filter((m) => m.role === 'assistant')
              .map((m) => m.text).join('. ');
            if (said) speakText(said);
          }
          setChatMsgs((cur) => {
            const next = (first || r.reset) ? r.messages : [...cur, ...r.messages];
            chatCache.current[key] = { msgs: next, since: chatSince.current,
              avail: true, status: chatStat.current };
            return next;
          });
        } else {
          const c = chatCache.current[key];
          chatCache.current[key] = {
            msgs: c?.msgs ?? [], since: chatSince.current, avail: true,
            status: chatStat.current,
          };
        }
        setStatus('up');
      } catch (e) {
        if (!live) return;
        // 404 = older server without the endpoint — use the terminal there
        if (e instanceof ApiError && e.status === 404) setChatAvail(false);
        else setStatus('down');
      }
    };
    void pull();
    const t = setInterval(() => void pull(), 2000);
    // leaving the tab shuts the narrator up mid-sentence
    return () => { live = false; clearInterval(t); Speech.stop(); setSpeaking(false); };
  }, [chatOn, box?.id, box?.token, projectId]);
  // inverted list wants newest-first
  const chatData = useMemo(() => [...chatMsgs].reverse(), [chatMsgs]);

  // 🔊 read replies aloud on THIS device (AVSpeechSynthesizer — the phone
  // talks, not the server). Tap = speak/stop the latest reply; long-press
  // arms auto-speak, reading each new reply as it lands. Ref mirrors the
  // toggle so the poll closure sees the current value.
  const [speaking, setSpeaking] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(false);
  const autoSpeakRef = useRef(false);
  useEffect(() => {
    void SecureStore.getItemAsync('tc.autoSpeak').then((r) => {
      autoSpeakRef.current = r === '1';
      setAutoSpeak(r === '1');
    });
    // AVSpeechSynthesizer is muted by the iPhone silent switch under the
    // default audio session — opt into playback so 🔊 works regardless
    void setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
  }, []);
  const speakText = useCallback((raw: string) => {
    // markdown reads terribly aloud — drop the syntax, keep the words
    const t = raw
      .replace(/```[\s\S]*?```/g, ' code block. ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/^\s*\|[\s:|-]+\|\s*$/gm, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_#>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!t) return;
    Speech.stop();
    setSpeaking(true);
    Speech.speak(t, {
      onDone: () => setSpeaking(false),
      onStopped: () => setSpeaking(false),
      onError: () => setSpeaking(false),
    });
  }, []);
  const speakLatest = () => {
    if (speaking) { Speech.stop(); setSpeaking(false); return; }
    const t = [...chatMsgs].reverse().find((m) => m.role === 'assistant')?.text;
    if (t) speakText(t);
  };
  const toggleAutoSpeak = () => {
    const next = !autoSpeakRef.current;
    autoSpeakRef.current = next;
    setAutoSpeak(next);
    void SecureStore.setItemAsync('tc.autoSpeak', next ? '1' : '0');
    if (!next) { Speech.stop(); setSpeaking(false); }
  };

  const js = useCallback((code: string) => {
    web.current?.injectJavaScript(`window.TC && (${code}); true;`);
  }, []);

  // one input path for the terminals and the chat view. Chat input rides the
  // server's send-keys/paste endpoints — no live terminal connection needed.
  const sendKey = (k: string) => {
    if (chatActive) { if (box && project) void termKey(box, project.id, k).catch(() => {}); }
    else js(`TC.key(${JSON.stringify(k)})`);
  };
  const sendPaste = (t: string) => {
    if (chatActive) { if (box && project) void termPaste(box, project.id, t).catch(() => {}); }
    else js(`TC.paste(${JSON.stringify(t)})`);
  };

  const paste = async () => {
    const t = await Clipboard.getStringAsync();
    if (t) sendPaste(t);
  };
  // 📎 attach: pick a screenshot (Photos on the phone, a file panel on the
  // Mac), upload it to the box, and drop the server-side path into the
  // message — Claude opens the image from that path itself.
  const [attaching, setAttaching] = useState(false);
  const attachUpload = async (name: string, b64: string) => {
    if (!box) return;
    setAttaching(true);
    try {
      const r = await uploadFile(box, name, b64);
      setDictText((t) => (t && !t.endsWith(' ') ? `${t} ` : t) + `${r.path} `);
    } catch {
      Alert.alert('Upload failed', 'Could not send the file to the box.');
    } finally { setAttaching(false); }
  };
  // native drop (Mac/iPad): the zone copied the item into app tmp; read it
  // and ride the same upload path as 📎
  const handleDrop = async (e: DropEvent) => {
    const { name, path } = e.nativeEvent;
    try {
      const b64 = await FileSystem.readAsStringAsync(`file://${path}`,
        { encoding: FileSystem.EncodingType.Base64 });
      await attachUpload(name || 'dropped.png', b64);
    } catch {
      Alert.alert('Drop failed', 'Could not read the dropped file.');
    }
  };
  const attach = () => {
    Alert.alert('Attach', 'Uploads to the box and puts the file path in your message so Claude can open it.', [
      {
        text: 'Clipboard image',
        onPress: () => void (async () => {
          const img = await Clipboard.getImageAsync({ format: 'png' })
            .catch(() => null);
          if (!img?.data) {
            Alert.alert('No image on the clipboard',
              'Copy a screenshot first (⌘⇧⌃4 on the Mac), then try again.');
            return;
          }
          await attachUpload('clipboard.png',
            img.data.replace(/^data:image\/\w+;base64,/, ''));
        })(),
      },
      {
        text: 'Photo library',
        onPress: () => void (async () => {
          const res = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'], base64: true, quality: 0.9,
          });
          const a = res.assets?.[0];
          if (a?.base64) await attachUpload(a.fileName ?? 'photo.jpg', a.base64);
        })(),
      },
      {
        text: 'Choose file',
        onPress: () => void (async () => {
          const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
          const a = res.assets?.[0];
          if (!a) return;
          const b64 = await FileSystem.readAsStringAsync(a.uri,
            { encoding: FileSystem.EncodingType.Base64 });
          await attachUpload(a.name ?? 'file', b64);
        })(),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };
  // composer send: clear the box, then paste + ⏎ the text
  const swallowNewline = useRef(false);
  const composerSubmit = () => {
    const t = dictText;
    setDictText('');
    if (t.trim()) void sendSubmit(t);
  };
  // paste + ⏎ — actually submits the message instead of leaving it on the
  // prompt for review; sequential so Enter can't outrun the paste
  const sendSubmit = async (t: string) => {
    if (chatActive) {
      if (!box || !project) return;
      try {
        await termPaste(box, project.id, t);
        await termKey(box, project.id, 'enter');
      } catch { /* next poll shows reality */ }
    } else {
      sendPaste(t);
      setTimeout(() => sendKey('enter'), 200);
    }
  };

  // terminal-mode ⌨ drawer — the key row and edit buttons fold away since
  // chat mode owns reading/copying/composing now
  const [keysOpen, setKeysOpen] = useState(false);
  // ↻ hard-reload: bumping the nonce re-keys the WebView, forcing a fresh
  // term.html load + tmux attach — the escape hatch for the occasional
  // wrong-terminal-in-tab attach
  const [webNonce, setWebNonce] = useState(0);
  // 📜 tmux mouse/scroll mode — on by default fleet-wide (term.sh); this
  // toggles it per-session for when you want selection-style dragging.
  const [mouseOn, setMouseOn] = useState(true);
  useEffect(() => { setMouseOn(true); }, [projectId]);  // sessions default on
  const toggleMouse = async () => {
    if (!box || !project) return;
    try {
      const r = await termMouse(box, project.id, !mouseOn);
      setMouseOn(r.mouse === 'on');
    } catch { /* leave as-is */ }
  };

  // Copy priority: (1) the tmux paste buffer — with mouse mode on, a drag
  // lands there ("N characters copied to the tmux buffer"), which is exactly
  // what the user just watched happen; (2) xterm's own selection (mouse mode
  // off); (3) the whole scrollback via capture-pane.
  const copyOut = async () => {
    if (!box) return;
    if (chatActive) {
      // chat: Copy = Claude's latest response (long-press a bubble for
      // others). Return here — falling through to the terminal paths let a
      // stale native selection / tmux buffer overwrite the chat text.
      const t = [...chatMsgs].reverse().find((m) => m.role === 'assistant')?.text ?? '';
      if (!t) return;
      await Clipboard.setStringAsync(t.replace(/\s+$/, ''));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      return;
    }
    let text = '';
    if (!text) {
      try { text = (await termBuffer(box)).content; } catch { /* fall through */ }
    }
    if (!text) text = lastSel.current;
    if (!text && project) {
      try { text = (await termCapture(box, project.id)).content; } catch { return; }
    }
    if (!text) return;
    await Clipboard.setStringAsync(text.replace(/\s+$/, ''));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // ＋ new tab — name + directory, straight onto the server registry (the
  // web dashboard's add-project, which didn't survive the app migration).
  // Missing directory → offer to create it (server mkdir -p on retry).
  const [addingTab, setAddingTab] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDir, setNewDir] = useState('');
  // folder picker inside the new-tab modal — server-side listing via
  // /api/browse (the phone can't see the box's filesystem any other way)
  const [browse, setBrowse] = useState<
    { dir: string; parent: string; entries: BrowseEntry[] } | null>(null);
  const openAddTab = () => {
    setNewDir((d) => d || (projectsRoot ? projectsRoot + '/' : ''));
    setBrowse(null);
    setAddingTab(true);
  };
  const closeAddTab = () => { setAddingTab(false); setBrowse(null); };
  const openBrowse = async (dir?: string) => {
    if (!box) return;
    // start from what's typed (minus any trailing slash / unfinished name the
    // server would reject) — the server falls back to $HOME if it's not a dir
    const start = dir ?? (newDir.trim().replace(/\/+$/, '') || projectsRoot || '/home');
    try { setBrowse(await browseDir(box, start)); }
    catch { /* box unreachable — the Add path still works by typing */ }
  };
  const submitNewTab = async (create: boolean) => {
    if (!box) return;
    const name = newName.trim(), dir = newDir.trim();
    if (!name || !dir) return;
    try {
      const r = await createProject(box, name, dir, create);
      closeAddTab();
      setNewName('');
      setNewDir('');
      await loadProjects();
      setStatus('connecting');
      setProjectId(r.id);
    } catch (e) {
      if (e instanceof ApiError && e.body?.missing_dir) {
        Alert.alert('Directory not found', `Create ${dir}?`, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Create it', onPress: () => void submitNewTab(true) },
        ]);
      } else {
        Alert.alert('Could not add tab',
          e instanceof Error ? e.message : String(e));
      }
    }
  };

  // long-press a project: move/hide/unhide/delete (mirrors the web sidebar)
  const projectMenu = (p: Project) => {
    if (!box) return;
    const b = box;
    const reload = () => void loadProjects();
    Alert.alert(p.name, undefined, [
      { text: '↑ Move up',
        onPress: () => void moveProject(b, p.id, -1).then(reload).catch(() => {}) },
      { text: '↓ Move down',
        onPress: () => void moveProject(b, p.id, 1).then(reload).catch(() => {}) },
      p.hidden
        ? { text: 'Unhide', onPress: () => void setProjectHidden(b, p.id, false).then(reload) }
        : { text: 'Hide', onPress: () => void setProjectHidden(b, p.id, true).then(reload) },
      {
        text: 'Delete tab', style: 'destructive',
        onPress: () => Alert.alert(`Delete "${p.name}"?`,
          'Files on disk are NOT touched — this only removes the tab and its tmux session.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive',
              onPress: () => void deleteProject(b, p.id).then(reload) },
          ]),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const pickBox = (b: Box) => {
    if (!tokenAlive(b)) {
      Alert.alert(`${b.name} session expired`,
        'Go back to the machines screen and log in again.');
      return;
    }
    if (b.id === boxId) return;
    // render the cached list instantly and jump straight to the remembered
    // tab — the chat effect keys off projectId, so the transcript fetch
    // races the project-list refresh instead of waiting behind it
    const cached = projCache.current[b.id];
    const remembered = lastByBox.current[b.id];
    setProjects(cached ?? []);
    setProjectId(
      cached && remembered && cached.some((p) => p.id === remembered) ? remembered
        : cached ? cached.find((p) => !p.hidden)?.id
        : remembered);
    setStatus('connecting');
    setBoxId(b.id);
  };

  // stretch rows to consume the sidebar: available height / slot count,
  // clamped between a dense minimum and a billboard maximum (both zoomed)
  const slots = visible.length + (showHidden ? hidden.length : 0);
  const availH = sideH - 46 /* zoom bar */ - 12 /* padding */ -
    (hidden.length ? 30 : 0) /* hidden header */;
  const rowH = slots > 0 && availH > 0
    ? Math.max(34 * Z, Math.min(84 * Z, availH / slots - 3))
    : 40 * Z;

  const projectRow = (p: Project, compact: boolean) => (
    <Pressable
      key={p.id}
      style={[
        compact ? s.pchip : s.prow,
        compact
          ? { paddingHorizontal: 10 * Z, paddingVertical: 6 * Z }
          : { height: rowH, paddingHorizontal: 9 * Z },
        { borderLeftColor: p.color ?? 'transparent' },
        p.id === projectId && s.pactive,
        p.hidden && { opacity: 0.5 },
      ]}
      onPress={() => { setStatus('connecting'); setProjectId(p.id); }}
      onLongPress={() => projectMenu(p)}
    >
      {p.claude_running && <View style={s.claude} />}
      <Text style={[s.pname, { fontSize: 13 * Z }, p.id === projectId && { color: C.text }]}
        numberOfLines={1}>{p.name}</Text>
    </Pressable>
  );

  // chat column doubles as a drop target where the native zone exists —
  // dropping a screenshot anywhere on the conversation uploads it
  const DropWrap: ElementType = chatActive && TCDropZone ? TCDropZone : View;
  const dropProps = chatActive && TCDropZone
    ? { onDrop: (e: DropEvent) => void handleDrop(e) } : {};

  // composer + session-status strip, hoisted so each layout can place them:
  // phones peg both directly under the project chips (the screen bottom is a
  // reach, and the keyboard half-covers it); wide screens keep the
  // messaging-app bottom bar.
  const chatStatusEl = chatActive
    && (chatStatus.permissionMode || chatStatus.contextTokens) ? (
      /* the TUI footer's session status: permission mode + how much
         context /clear would free (typing /clear in the composer
         actually runs it) */
      <Text style={[s.chatStatus, !wide && s.chatStatusTop]} numberOfLines={1}>
        {[
          modeLabel(chatStatus.permissionMode),
          chatStatus.contextTokens
            ? `/clear to save ${fmtTokens(chatStatus.contextTokens)} tokens`
            : '',
        ].filter(Boolean).join(' · ')}
      </Text>
    ) : null;
  const chatBarEl = chatActive ? (
    /* the input IS the bar — a messaging-app composer. On phones the
       keyboard mic dictates straight into it; on hardware keyboards (Mac)
       ⏎ submits directly. 🖥 flips to terminal, 📎 attaches a screenshot,
       🔊 speaks the latest reply, 📄 (wide) copies it, Esc interrupts
       Claude. More old-bar buttons return here only as they prove needed. */
    <View style={[s.chatBar, !wide && s.chatBarTop]}>
      {/* while typing, the mode toggle yields its slot to ⌄
          (collapse keyboard) — you don't flip views mid-message,
          but you do want your reading space back */}
      {kbUp ? (
        <Pressable style={s.cbtn} onPress={() => Keyboard.dismiss()}>
          <Text style={[s.klabel, { fontWeight: '700' }]}>⌄</Text>
        </Pressable>
      ) : (
        <Pressable style={s.cbtn} onPress={toggleChat}>
          <Text style={s.klabel}>🖥</Text>
        </Pressable>
      )}
      <Pressable style={s.cbtn} onPress={attach} disabled={attaching}>
        <Text style={s.klabel}>{attaching ? '⏳' : '📎'}</Text>
      </Pressable>
      {/* Aa: cycle chat text size (4 steps, wraps) */}
      <Pressable style={s.cbtn} onPress={cycleChatSize}>
        <Text style={s.klabel}>Aa</Text>
      </Pressable>
      {/* 🔊 speak the latest reply (tap again stops); long-press
          arms auto-speak — accent border = on. Yields its slot to
          the input while typing on phones. */}
      {(!kbUp || wide) && (
        <Pressable
          style={[s.cbtn, autoSpeak && { borderColor: C.accent }]}
          onPress={speakLatest} onLongPress={toggleAutoSpeak}>
          <Text style={s.klabel}>{speaking ? '⏹' : '🔊'}</Text>
        </Pressable>
      )}
      <TextInput
        style={[s.chatInput,
          { height: Math.min(120, Math.max(44, composerH + 24)) }]}
        multiline
        onContentSizeChange={(e) =>
          setComposerH(e.nativeEvent.contentSize.height)}
        placeholder={wide ? 'Message — ⏎ sends' : 'Message (🎤 to dictate)'}
        placeholderTextColor={C.muted}
        value={dictText}
        /* wide = hardware keyboard: a bare ⏎ sends instead of adding
           a newline (the guard swallows the '\n' that follows the
           keypress; a multiline paste never matches key 'Enter') */
        onKeyPress={wide ? (e) => {
          if (e.nativeEvent.key === 'Enter') {
            swallowNewline.current = true;
            composerSubmit();
          }
        } : undefined}
        onChangeText={(t) => {
          if (swallowNewline.current) {
            swallowNewline.current = false;
            return;
          }
          setDictText(t);
        }}
      />
      {wide && (
        <Pressable style={s.cbtn} onPress={copyOut}>
          <Text style={s.klabel}>{copied ? '✓' : '📄'}</Text>
        </Pressable>
      )}
      <Pressable style={s.cbtn} onPress={() => sendKey('esc')}>
        <Text style={s.klabel}>Esc</Text>
      </Pressable>
      <Pressable style={[s.cbtn, s.cSend]} onPress={composerSubmit}>
        <Text style={{ color: C.bg, fontWeight: '700' }}>⏎</Text>
      </Pressable>
    </View>
  ) : null;
  // terminal-mode button bar, hoisted for the same reason: phones peg it
  // under the project chips — sideways-sliding a bar at the very bottom
  // fights the iOS home-indicator gesture; wide screens keep it at the
  // bottom, where a mouse doesn't care.
  const termBarEl = !chatActive ? (
    <ScrollView
      horizontal keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}
      style={[s.bar, !wide && s.barTop]} contentContainerStyle={s.barInner}
    >
      {/* terminal mode is just a terminal now — chat owns reading,
          copying and composing. Slim bar: back to chat, the ⌨ key
          drawer, scrollback, engine toggles. Everything else folds
          into ⌨. */}
      <Pressable style={[s.kbtn, s.kwide]} onPress={toggleChat}>
        <Text style={s.klabel}>💬 Chat</Text>
      </Pressable>
      <Pressable style={[s.kbtn, keysOpen && { borderColor: C.accent }]}
        onPress={() => setKeysOpen(!keysOpen)}>
        <Text style={[s.klabel, keysOpen && { color: C.accent }]}>⌨</Text>
      </Pressable>
      {/* ↻ force a fresh terminal attach — for when a tab comes up
          showing the wrong project's session */}
      <Pressable style={s.kbtn}
        onPress={() => { setStatus('connecting'); setWebNonce((n) => n + 1); }}>
        <Text style={s.klabel}>↻</Text>
      </Pressable>
      {/* 📜 tmux mouse mode only matters where real wheel events exist
          (trackpad/mouse). On phones a swipe becomes a tmux drag, not a
          scroll — the toggle is invisible there, so don't show it. */}
      {wide && (
        <Pressable
          style={[s.kbtn, mouseOn && { borderColor: C.accent }]}
          onPress={toggleMouse}>
          <Text style={[s.klabel, mouseOn && { color: C.accent }]}>📜</Text>
        </Pressable>
      )}
      {keysOpen && (
        <>
          <View style={s.sep} />
          <Pressable style={s.kbtn}
            onPress={() => { setDictText(''); setDictating(true); }}>
            <Text style={s.klabel}>🎤</Text>
          </Pressable>
          <Pressable style={s.kbtn} onPress={paste}>
            <Text style={s.klabel}>📋</Text>
          </Pressable>
          <Pressable style={s.kbtn} onPress={copyOut}>
            <Text style={s.klabel}>{copied ? '✓' : '📄'}</Text>
          </Pressable>
          {KEYS.map((k) => (
            <Pressable key={k.key} style={[s.kbtn, k.wide && s.kwide]}
              onPress={() => sendKey(k.key)}>
              <Text style={s.klabel}>{k.label}</Text>
            </Pressable>
          ))}
          {/* dismisses the phone's on-screen keyboard — pointless with
              a hardware keyboard, so wide screens don't get it */}
          {!wide && (
            <Pressable style={[s.kbtn, s.kwide]}
              onPress={() => js('TC.blurKeyboard()')}>
              <Text style={s.klabel}>⌨ Hide</Text>
            </Pressable>
          )}
        </>
      )}
    </ScrollView>
  ) : null;
  // TUI-only prompts (permission menus, login codes) never reach the
  // transcript — when the server spots one on the live pane, banner it
  // here; tapping flips to the terminal to answer.
  const promptBanner = chatActive && chatStatus.awaitingInput ? (
    <Pressable onPress={toggleChat}>
      <Text style={s.promptBanner} numberOfLines={1}>
        ⚠ Claude is asking something in the terminal — tap to answer
      </Text>
    </Pressable>
  ) : null;

  return (
    <SafeAreaView style={s.root} edges={['top', 'left', 'right']}>
      <Stack.Screen options={{ headerShown: false }} />
      {/* header: back + machine chips + connection dot */}
      <View style={s.header}>
        <Pressable style={s.back} onPress={() => router.back()}>
          <Text style={s.backTxt}>‹</Text>
        </Pressable>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.chips}>
          {boxes.map((b) => (
            <Pressable key={b.id}
              style={[s.chip, b.id === boxId && s.chipActive,
                !tokenAlive(b) && s.chipDead]}
              onPress={() => pickBox(b)}>
              <Text style={[s.chipTxt, b.id === boxId && { color: C.text }]}>
                {b.name}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        <View style={[s.dot, {
          backgroundColor:
            status === 'up' ? C.green : status === 'down' ? C.red : C.amber,
        }]} />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={s.body}>
          {/* wide: persistent project sidebar */}
          {wide && (
            <View
              style={[s.sidebar, { width: 190 * Z }]}
              onLayout={(e) => setSideH(e.nativeEvent.layout.height)}
            >
              <ScrollView contentContainerStyle={{ padding: 6 }}>
                {visible.map((p) => projectRow(p, false))}
                {hidden.length > 0 && (
                  <Pressable style={s.hiddenHdr} onPress={() => setShowHidden(!showHidden)}>
                    <Text style={s.hiddenHdrTxt}>
                      {showHidden ? '▾' : '▸'} Hidden ({hidden.length})
                    </Text>
                  </Pressable>
                )}
                {showHidden && hidden.map((p) => projectRow(p, false))}
                <Pressable style={s.hiddenHdr} onPress={() => openAddTab()}>
                  <Text style={s.hiddenHdrTxt}>＋ New tab</Text>
                </Pressable>
              </ScrollView>
              {/* tab zoom for big monitors */}
              <View style={s.zoomRow}>
                <Pressable style={s.zoomBtn} onPress={() => bumpZoom(-1)}>
                  <Text style={s.zoomTxt}>A−</Text>
                </Pressable>
                <Pressable style={s.zoomBtn} onPress={() => bumpZoom(1)}>
                  <Text style={s.zoomTxt}>A+</Text>
                </Pressable>
              </View>
            </View>
          )}
          <DropWrap style={{ flex: 1 }} {...dropProps}>
            {/* narrow: project chip strip stays in sight above the terminal */}
            {!wide && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false}
                style={s.pstrip} contentContainerStyle={s.pstripInner}>
                {visible.map((p) => projectRow(p, true))}
                {hidden.length > 0 && (
                  <Pressable style={[s.pchip, { borderLeftColor: 'transparent' }]}
                    onPress={() => setShowHidden(!showHidden)}>
                    <Text style={s.pname}>🫥 {hidden.length}</Text>
                  </Pressable>
                )}
                {showHidden && hidden.map((p) => projectRow(p, true))}
                <Pressable style={[s.pchip, { borderLeftColor: 'transparent' }]}
                  onPress={() => openAddTab()}>
                  <Text style={s.pname}>＋</Text>
                </Pressable>
              </ScrollView>
            )}
            {/* phones: composer (chat) or button bar (terminal) rides just
                under the tabs — top of screen, where your eyes and thumb
                already are */}
            {!wide && chatBarEl}
            {!wide && promptBanner}
            {!wide && chatStatusEl}
            {!wide && termBarEl}
            {box && project && chatActive ? (
              /* 💬 chat — inverted virtualized list: opens at the newest
                 message and stays pinned there while output streams; scroll
                 up freely (position holds), long-press a message to copy it */
              <FlatList
                style={s.reader}
                contentContainerStyle={s.chatInner}
                inverted
                /* new messages insert at offset 0 of the inverted list; hold
                   the reader's place unless they're already at the newest end */
                maintainVisibleContentPosition={{
                  minIndexForVisible: 0, autoscrollToTopThreshold: 20,
                }}
                data={chatData}
                keyExtractor={(_m, i) => String(chatMsgs.length - i)}
                ListEmptyComponent={
                  <Text style={[s.histText, { color: C.muted, transform: [{ scaleY: -1 }] }]}>
                    {chatAvail === null ? 'Loading conversation…' : 'No messages yet.'}
                  </Text>
                }
                renderItem={({ item }) => {
                  const body = item.role === 'user' ? `❯ ${item.text}`
                    : item.role === 'tool' ? `● ${item.text}`
                    : item.role === 'result' ? `  ⎿ ${item.text}`
                    : item.role === 'system' ? `✻ ${item.text}`
                    : item.text;
                  const dim = item.role === 'tool' || item.role === 'result'
                    || item.role === 'system';
                  // rich segments: bare HTML blocks and ```html fences render
                  // inline in an embedded web view; markdown tables re-pad
                  // into aligned columns in a horizontal scroller; prose
                  // between them stays a native text bubble
                  if (item.role === 'assistant'
                    && (item.text.includes('<') || item.text.includes('|'))) {
                    const parts: Array<{ kind: 'text' | 'table' | 'html'; text: string }> = [];
                    for (const hseg of splitHtml(item.text)) {
                      if (hseg.html) { parts.push({ kind: 'html', text: hseg.text }); continue; }
                      for (const tseg of splitMdTables(hseg.text)) {
                        parts.push({ kind: tseg.table ? 'table' : 'text', text: tseg.text });
                      }
                    }
                    if (parts.some((p) => p.kind !== 'text')) {
                      return (
                        <View style={s.chatMsg}>
                          {parts.map((p, i) => p.kind === 'html' ? (
                            <InlineHtml
                              key={i} html={p.text}
                              onExpand={() => setHtmlPreview(p.text)}
                            />
                          ) : p.kind === 'table' ? (
                            <ScrollView
                              key={i} horizontal style={s.tbl}
                              showsHorizontalScrollIndicator={false}
                            >
                              <Text selectable style={[s.histText, { fontSize: chatFs }]}>
                                {p.text}
                              </Text>
                            </ScrollView>
                          ) : selTextAvailable ? (
                            <SelText key={i} text={p.text} fontSize={chatFs} color={C.text} />
                          ) : (
                            <Text
                              key={i} selectable
                              style={[s.histText, { fontSize: chatFs }]}
                            >
                              {p.text}
                            </Text>
                          ))}
                        </View>
                      );
                    }
                  }
                  // native bubble: a real UITextView — drag-handle/mouse
                  // range selection and Cmd-C, which RN <Text> can't do
                  if (selTextAvailable) {
                    return (
                      <View style={[s.chatMsg, item.role === 'user' && s.chatUser]}>
                        <SelText
                          text={body}
                          fontSize={dim ? chatFs - 1 : chatFs}
                          color={item.role === 'user' ? C.accent
                            : dim ? C.muted : C.text}
                        />
                      </View>
                    );
                  }
                  return (
                    <Pressable
                      style={[s.chatMsg, item.role === 'user' && s.chatUser]}
                      onLongPress={() => {
                        void Clipboard.setStringAsync(item.text);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      }}
                    >
                      <Text
                        selectable
                        style={[
                          s.histText,
                          item.role === 'user' && { color: C.accent },
                          dim && s.chatDim,
                          { fontSize: dim ? chatFs - 1 : chatFs },
                        ]}
                      >
                        {body}
                      </Text>
                    </Pressable>
                  );
                }}
              />
            ) : box && project ? (
              <WebView
                key={`${box.id}:${project.id}:${webNonce}`}
                ref={web}
                source={{ uri: termUrl(box, project.id) }}
                style={s.web}
                originWhitelist={['https://*', 'http://*']}
                keyboardDisplayRequiresUserAction={false}
                hideKeyboardAccessoryView
                allowsLinkPreview={false}
                setSupportMultipleWindows={false}
                onMessage={(ev) => {
                  try {
                    const m = JSON.parse(ev.nativeEvent.data);
                    if (m.type === 'connected') setStatus('up');
                    else if (m.type === 'disconnected') setStatus('connecting');
                    else if (m.type === 'failed') setStatus('down');
                    else if (m.type === 'selection' && m.text) {
                      lastSel.current = m.text;
                      void Clipboard.setStringAsync(m.text);
                    }
                  } catch { /* not ours */ }
                }}
              />
            ) : (
              <View style={[s.web, s.center]}>
                <Text style={{ color: C.muted }}>
                  {boxes.length ? 'Loading projects…' : 'No machines — go back and add one.'}
                </Text>
              </View>
            )}
            {wide && promptBanner}
            {wide && chatStatusEl}
            {wide && chatBarEl}
            {wide && termBarEl}
          </DropWrap>
        </View>
      </KeyboardAvoidingView>

      {/* ＋ new tab — name + directory (server expands ~). 📁 opens a
          server-side folder browser (/api/browse): tap to descend, ⬆︎ to go
          up, "Use" drops the current folder into the directory field — type
          a new subfolder name after it and Add offers to create it. */}
      <Modal visible={addingTab} transparent animationType="fade"
        onRequestClose={closeAddTab}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={s.dictWrap}
        >
          <View style={s.dictBox}>
            <Text style={s.dictTitle}>＋ New tab</Text>
            <TextInput
              style={s.addInput} autoFocus
              placeholder="Name" placeholderTextColor={C.muted}
              value={newName} onChangeText={setNewName}
            />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput
                style={[s.addInput, { flex: 1 }]}
                autoCapitalize="none" autoCorrect={false}
                placeholder="Directory (e.g. ~/projects/foo)"
                placeholderTextColor={C.muted}
                value={newDir} onChangeText={setNewDir}
              />
              <Pressable style={s.kbtn}
                onPress={() => { browse ? setBrowse(null) : void openBrowse(); }}>
                <Text style={s.klabel}>📁</Text>
              </Pressable>
            </View>
            {browse && (
              <View style={s.browseBox}>
                <View style={s.browseHdr}>
                  <Text style={s.browsePath} numberOfLines={1}>{browse.dir}</Text>
                  <Pressable style={s.browseUse}
                    onPress={() => { setNewDir(browse.dir); setBrowse(null); }}>
                    <Text style={{ color: C.bg, fontWeight: '600', fontSize: 13 }}>Use</Text>
                  </Pressable>
                </View>
                <ScrollView style={{ maxHeight: 250 }}
                  keyboardShouldPersistTaps="handled">
                  {browse.dir !== '/' && (
                    <Pressable style={s.browseRow}
                      onPress={() => void openBrowse(browse.parent)}>
                      <Text style={s.browseName}>⬆︎  ..</Text>
                    </Pressable>
                  )}
                  {browse.entries
                    .filter((e) => e.is_dir && !e.name.startsWith('.'))
                    .map((e) => (
                      <Pressable key={e.path} style={s.browseRow}
                        onPress={() => void openBrowse(e.path)}>
                        <Text style={s.browseName} numberOfLines={1}>📁 {e.name}</Text>
                      </Pressable>
                    ))}
                  {!browse.entries.some((e) => e.is_dir && !e.name.startsWith('.')) && (
                    <Text style={[s.browseName, { color: C.muted, padding: 10 }]}>
                      no subfolders — Use this one or type a new name after it
                    </Text>
                  )}
                </ScrollView>
              </View>
            )}
            <View style={s.dictBtns}>
              <Pressable style={s.kbtn} onPress={closeAddTab}>
                <Text style={{ color: C.muted }}>Cancel</Text>
              </Pressable>
              <Pressable style={[s.kbtn, s.kwide, { backgroundColor: C.accent }]}
                onPress={() => void submitNewTab(false)}>
                <Text style={{ color: C.bg, fontWeight: '600' }}>Add</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* 🎤 dictation box — iOS dictation streams partial phrases, and typing
          those straight into xterm duplicates every fragment. A native input
          captures it cleanly; Send bracketed-pastes it onto the prompt
          WITHOUT running it, so you review and hit ⏎ yourself. */}
      <Modal visible={dictating} transparent animationType="fade"
        onRequestClose={() => setDictating(false)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={s.dictWrap}
        >
          <View style={s.dictBox}>
            <Text style={s.dictTitle}>🎤 Dictate to terminal</Text>
            <TextInput
              style={s.dictInput}
              multiline autoFocus
              placeholder="Speak or type here…" placeholderTextColor={C.muted}
              value={dictText} onChangeText={setDictText}
            />
            <View style={s.dictBtns}>
              <Pressable style={s.kbtn} onPress={() => setDictating(false)}>
                <Text style={{ color: C.muted }}>Cancel</Text>
              </Pressable>
              <Pressable style={[s.kbtn, s.kwide]}
                onPress={() => {
                  if (dictText.trim()) sendPaste(dictText);
                  setDictating(false);
                }}>
                <Text style={s.klabel}>Place only</Text>
              </Pressable>
              <Pressable style={[s.kbtn, s.kwide, { backgroundColor: C.accent }]}
                onPress={() => {
                  if (dictText.trim()) void sendSubmit(dictText);
                  setDictating(false);
                }}>
                <Text style={{ color: C.bg, fontWeight: '600' }}>Send ⏎</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* 🌐 HTML preview — a reply's HTML rendered in a real browser view.
          Content is inline (source.html), so it works offline and for old
          transcripts; external links open in place, ✕ comes back to chat. */}
      <Modal visible={htmlPreview !== null} animationType="slide"
        onRequestClose={() => setHtmlPreview(null)}>
        <View style={[s.htmlWrap, {
          paddingTop: insets.top, paddingBottom: insets.bottom,
        }]}>
          <View style={s.htmlBar}>
            <Text style={s.htmlTitle}>🌐 HTML preview</Text>
            <Pressable
              style={s.htmlClose} hitSlop={12}
              onPress={() => setHtmlPreview(null)}
            >
              <Text style={s.htmlCloseText}>✕ Close</Text>
            </Pressable>
          </View>
          {htmlPreview !== null && (
            <WebView
              source={{ html: htmlPreview }}
              style={s.web}
              originWhitelist={['*']}
              setSupportMultipleWindows={false}
              allowsLinkPreview={false}
            />
          )}
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.panel },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: C.panel, borderBottomWidth: 1, borderBottomColor: C.border,
    paddingHorizontal: 8, paddingVertical: 6,
  },
  back: { paddingHorizontal: 8, paddingVertical: 2 },
  backTxt: { color: C.accent, fontSize: 26, lineHeight: 28 },
  chips: { gap: 6, alignItems: 'center' },
  chip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 15,
    backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border,
  },
  chipActive: { borderColor: C.accent },
  chipDead: { opacity: 0.45 },
  chipTxt: { color: C.muted, fontSize: 13, fontWeight: '600' },
  dot: { width: 9, height: 9, borderRadius: 5, marginHorizontal: 6 },
  body: { flex: 1, flexDirection: 'row', backgroundColor: '#000' },
  sidebar: {
    backgroundColor: C.bg,
    borderRightWidth: 1, borderRightColor: C.border,
  },
  zoomRow: {
    flexDirection: 'row', gap: 6, padding: 8,
    borderTopWidth: 1, borderTopColor: C.border,
  },
  zoomBtn: {
    flex: 1, alignItems: 'center', paddingVertical: 6, borderRadius: 7,
    backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border,
  },
  zoomTxt: { color: C.muted, fontSize: 13, fontWeight: '600' },
  prow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    padding: 9, borderRadius: 7, marginBottom: 3,
    borderLeftWidth: 3, borderLeftColor: 'transparent',
  },
  pchip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 7,
    backgroundColor: C.bg, borderLeftWidth: 3,
  },
  pactive: { backgroundColor: C.panel2 },
  hiddenHdr: { padding: 8, marginTop: 4 },
  hiddenHdrTxt: { color: C.muted, fontSize: 12 },
  pname: { color: C.muted, fontSize: 13, flexShrink: 1 },
  claude: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.green },
  pstrip: {
    flexGrow: 0, backgroundColor: C.bg,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  pstripInner: { padding: 5, gap: 5, alignItems: 'center' },
  web: { flex: 1, backgroundColor: '#000' },
  reader: { flex: 1, backgroundColor: '#000' },
  chatInner: { padding: 10 },
  chatMsg: { marginVertical: 3 },
  tbl: { marginVertical: 4 },
  inlineHtml: {
    marginVertical: 4, borderColor: C.border, borderWidth: 1,
    borderRadius: 8, overflow: 'hidden',
  },
  htmlExpand: {
    paddingHorizontal: 10, paddingVertical: 5,
    borderTopWidth: 1, borderTopColor: C.border,
  },
  htmlChipText: { color: C.accent, fontSize: 12 },
  htmlWrap: { flex: 1, backgroundColor: C.panel },
  htmlBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  htmlTitle: { color: C.text, fontSize: 14, fontWeight: '600' },
  htmlClose: {
    paddingHorizontal: 14, paddingVertical: 6,
    borderColor: C.border, borderWidth: 1, borderRadius: 8,
  },
  htmlCloseText: { color: C.text, fontSize: 15 },
  chatUser: { marginTop: 10 },
  chatDim: { color: C.muted, fontSize: 11 },
  chatStatus: {
    color: C.muted, fontSize: 11, paddingHorizontal: 14, paddingVertical: 3,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border,
  },
  // top-of-screen variants (phones): borders flip to the underside
  chatStatusTop: {
    borderTopWidth: 0,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border,
  },
  chatBarTop: {
    borderTopWidth: 0, borderBottomWidth: 1, borderBottomColor: C.border,
  },
  barTop: {
    borderTopWidth: 0, borderBottomWidth: 1, borderBottomColor: C.border,
  },
  promptBanner: {
    color: C.amber, fontSize: 12, fontWeight: '600',
    paddingHorizontal: 14, paddingVertical: 5, backgroundColor: C.panel,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border,
  },
  chatBar: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 6,
    padding: 8, backgroundColor: C.panel,
    borderTopWidth: 1, borderTopColor: C.border,
  },
  chatInput: {
    flex: 1, color: C.text, fontSize: 15, maxHeight: 120,
    backgroundColor: C.bg, borderRadius: 10, borderWidth: 1,
    borderColor: C.border, paddingHorizontal: 12, paddingVertical: 11,
  },
  cbtn: {
    paddingHorizontal: 12, paddingVertical: 13, borderRadius: 10,
    borderWidth: 1, borderColor: C.border,
  },
  cSend: { backgroundColor: C.accent, borderColor: C.accent },
  center: { alignItems: 'center', justifyContent: 'center' },
  bar: {
    flexGrow: 0, backgroundColor: C.panel,
    borderTopWidth: 1, borderTopColor: C.border,
  },
  barInner: { padding: 8, gap: 6, alignItems: 'center' },
  kbtn: {
    minWidth: 44, height: 50, borderRadius: 8, paddingHorizontal: 10,
    backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border,
    alignItems: 'center', justifyContent: 'center',
  },
  dictWrap: {
    flex: 1, backgroundColor: 'rgba(0,0,0,.6)',
    justifyContent: 'center', padding: 22,
  },
  dictBox: {
    backgroundColor: C.panel, borderRadius: 12, padding: 16,
    borderWidth: 1, borderColor: C.border, gap: 10,
  },
  dictTitle: { color: C.text, fontSize: 16, fontWeight: '600' },
  dictInput: {
    minHeight: 120, maxHeight: 260, textAlignVertical: 'top',
    backgroundColor: C.bg, borderColor: C.border, borderWidth: 1,
    borderRadius: 8, color: C.text, padding: 11, fontSize: 16,
  },
  dictBtns: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  addInput: {
    backgroundColor: C.bg, borderColor: C.border, borderWidth: 1,
    borderRadius: 8, color: C.text, padding: 11, fontSize: 16,
  },
  browseBox: {
    backgroundColor: C.bg, borderColor: C.border, borderWidth: 1,
    borderRadius: 8, overflow: 'hidden',
  },
  browseHdr: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 10, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: C.border,
    backgroundColor: C.panel2,
  },
  browsePath: { flex: 1, color: C.muted, fontSize: 13 },
  browseUse: {
    backgroundColor: C.accent, borderRadius: 6,
    paddingHorizontal: 12, paddingVertical: 5,
  },
  browseRow: {
    paddingHorizontal: 10, paddingVertical: 9,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  browseName: { color: C.text, fontSize: 15 },
  histText: {
    color: C.text, fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  kwide: { paddingHorizontal: 14 },
  klabel: { color: C.text, fontSize: 14 },
  sep: { width: 1, height: 24, backgroundColor: C.border, marginHorizontal: 4 },
});
