// The workspace — the screen you live in. Machines as chips across the top
// (one tap to jump boxes), the current box's projects always in sight (a
// sidebar on wide screens, a chip strip on phones), terminal filling the
// rest. Layout mirrors the web dashboard's always-visible sidebar instead of
// v1's list → list → terminal drill-down.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView,
  StyleSheet, Text, TextInput, useWindowDimensions, View,
} from 'react-native';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import * as Clipboard from 'expo-clipboard';
import * as SecureStore from 'expo-secure-store';
import {
  deleteProject, getProjects, Project, setProjectHidden, termBuffer,
  termCapture, termUrl,
} from '@/lib/api';
import { Box, loadBoxes, tokenAlive } from '@/lib/boxes';
import { C } from '@/lib/theme';

const KEYS: Array<{ label: string; key: string; wide?: boolean }> = [
  { label: '↑', key: 'up' }, { label: '↓', key: 'down' },
  { label: '←', key: 'left' }, { label: '→', key: 'right' },
  { label: 'Esc', key: 'esc' }, { label: '⇥', key: 'tab' },
  { label: '⇧⇥', key: 'btab', wide: true },
  { label: '^C', key: 'ctrl-c' }, { label: '⏎', key: 'enter' },
];

export default function Workspace() {
  const params = useLocalSearchParams<{ box?: string; project?: string }>();
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [boxId, setBoxId] = useState<string | undefined>(params.box);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | undefined>(params.project);
  const [status, setStatus] = useState<'connecting' | 'up' | 'down'>('connecting');
  const [showHidden, setShowHidden] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [dictText, setDictText] = useState('');
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

  const loadProjects = useCallback(() => {
    if (!box) return Promise.resolve();
    const bid = box.id;
    return getProjects(box).then((d) => {
      setProjects(d.projects);
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

  const js = useCallback((code: string) => {
    web.current?.injectJavaScript(`window.TC && (${code}); true;`);
  }, []);

  const paste = async () => {
    const t = await Clipboard.getStringAsync();
    if (t) js(`TC.paste(${JSON.stringify(t)})`);
  };

  // Copy priority: (1) the tmux paste buffer — with mouse mode on, a drag
  // lands there ("N characters copied to the tmux buffer"), which is exactly
  // what the user just watched happen; (2) xterm's own selection (mouse mode
  // off); (3) the whole scrollback via capture-pane.
  const copyOut = async () => {
    if (!box) return;
    let text = '';
    try { text = (await termBuffer(box)).content; } catch { /* fall through */ }
    if (!text) text = lastSel.current;
    if (!text && project) {
      try { text = (await termCapture(box, project.id)).content; } catch { return; }
    }
    if (!text) return;
    await Clipboard.setStringAsync(text.replace(/\s+$/, ''));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // long-press a project: hide/unhide/delete (mirrors the web sidebar's − and 🗑)
  const projectMenu = (p: Project) => {
    if (!box) return;
    const b = box;
    const reload = () => void loadProjects();
    Alert.alert(p.name, undefined, [
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
    if (b.id !== boxId) { setProjectId(undefined); setProjects([]); setBoxId(b.id); }
  };

  const projectRow = (p: Project, compact: boolean) => (
    <Pressable
      key={p.id}
      style={[
        compact ? s.pchip : s.prow,
        compact
          ? { paddingHorizontal: 10 * Z, paddingVertical: 6 * Z }
          : { padding: 9 * Z },
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
            <View style={[s.sidebar, { width: 190 * Z }]}>
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
          <View style={{ flex: 1 }}>
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
              </ScrollView>
            )}
            {box && project ? (
              <WebView
                key={`${box.id}:${project.id}`}
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
            <ScrollView
              horizontal keyboardShouldPersistTaps="always"
              showsHorizontalScrollIndicator={false}
              style={s.bar} contentContainerStyle={s.barInner}
            >
              {KEYS.map((k) => (
                <Pressable key={k.key} style={[s.kbtn, k.wide && s.kwide]}
                  onPress={() => js(`TC.key(${JSON.stringify(k.key)})`)}>
                  <Text style={s.klabel}>{k.label}</Text>
                </Pressable>
              ))}
              <View style={s.sep} />
              <Pressable style={[s.kbtn, s.kwide]}
                onPress={() => { setDictText(''); setDictating(true); }}>
                <Text style={s.klabel}>🎤 Dictate</Text>
              </Pressable>
              <Pressable style={[s.kbtn, s.kwide]} onPress={paste}>
                <Text style={s.klabel}>📋 Paste</Text>
              </Pressable>
              <Pressable style={[s.kbtn, s.kwide]} onPress={copyOut}>
                <Text style={s.klabel}>{copied ? '✓ Copied' : '📄 Copy'}</Text>
              </Pressable>
              {/* dismisses the phone's on-screen keyboard — pointless with a
                  hardware keyboard, so wide screens don't get it */}
              {!wide && (
                <Pressable style={[s.kbtn, s.kwide]} onPress={() => js('TC.blurKeyboard()')}>
                  <Text style={s.klabel}>⌨ Hide</Text>
                </Pressable>
              )}
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>

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
            <Text style={s.dictHint}>
              Tap the keyboard mic and speak — transcription stays clean here.
              Send drops it on the prompt without running it.
            </Text>
            <TextInput
              style={s.dictInput}
              multiline autoFocus
              placeholder="Speak or type here…" placeholderTextColor={C.muted}
              value={dictText} onChangeText={setDictText}
            />
            <View style={s.dictBtns}>
              <Pressable style={[s.kbtn, s.kwide]} onPress={() => setDictating(false)}>
                <Text style={{ color: C.muted }}>Cancel</Text>
              </Pressable>
              <Pressable style={[s.kbtn, s.kwide, { backgroundColor: C.accent }]}
                onPress={() => {
                  if (dictText.trim()) js(`TC.paste(${JSON.stringify(dictText)})`);
                  setDictating(false);
                }}>
                <Text style={{ color: C.bg, fontWeight: '600' }}>Send to terminal</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
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
  center: { alignItems: 'center', justifyContent: 'center' },
  bar: {
    flexGrow: 0, backgroundColor: C.panel,
    borderTopWidth: 1, borderTopColor: C.border,
  },
  barInner: { padding: 6, gap: 6, alignItems: 'center' },
  kbtn: {
    minWidth: 44, height: 40, borderRadius: 8, paddingHorizontal: 10,
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
  dictHint: { color: C.muted, fontSize: 12.5, lineHeight: 18 },
  dictInput: {
    minHeight: 120, maxHeight: 260, textAlignVertical: 'top',
    backgroundColor: C.bg, borderColor: C.border, borderWidth: 1,
    borderRadius: 8, color: C.text, padding: 11, fontSize: 16,
  },
  dictBtns: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  kwide: { paddingHorizontal: 14 },
  klabel: { color: C.text, fontSize: 14 },
  sep: { width: 1, height: 24, backgroundColor: C.border, marginHorizontal: 4 },
});
