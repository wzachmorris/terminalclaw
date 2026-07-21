// The workspace — the screen you live in. Machines as chips across the top
// (one tap to jump boxes), the current box's projects always in sight (a
// sidebar on wide screens, a chip strip on phones), terminal filling the
// rest. Layout mirrors the web dashboard's always-visible sidebar instead of
// v1's list → list → terminal drill-down.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet,
  Text, useWindowDimensions, View,
} from 'react-native';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import * as Clipboard from 'expo-clipboard';
import { getProjects, Project, termUrl } from '@/lib/api';
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
  const web = useRef<WebView>(null);
  const wide = useWindowDimensions().width >= 700;

  const box = boxes.find((b) => b.id === boxId);
  const project = projects.find((p) => p.id === projectId);

  useFocusEffect(useCallback(() => {
    void loadBoxes().then((bs) => {
      setBoxes(bs);
      if (!boxId && bs.length) setBoxId(bs[0].id);
    });
  }, [boxId]));

  // load (and lightly poll) the selected box's projects
  useEffect(() => {
    if (!box) return;
    let live = true;
    const load = () => getProjects(box).then((d) => {
      if (!live) return;
      const vis = d.projects.filter((p) => !p.hidden);
      setProjects(vis);
      setProjectId((cur) =>
        cur && vis.some((p) => p.id === cur) ? cur : vis[0]?.id);
    }).catch(() => { /* poll again; terminal itself shows real failures */ });
    load();
    const t = setInterval(load, 15000);
    return () => { live = false; clearInterval(t); };
  }, [box?.id, box?.token]);

  const js = useCallback((code: string) => {
    web.current?.injectJavaScript(`window.TC && (${code}); true;`);
  }, []);

  const paste = async () => {
    const t = await Clipboard.getStringAsync();
    if (t) js(`TC.paste(${JSON.stringify(t)})`);
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
        { borderLeftColor: p.color ?? 'transparent' },
        p.id === projectId && s.pactive,
      ]}
      onPress={() => { setStatus('connecting'); setProjectId(p.id); }}
    >
      {p.claude_running && <View style={s.claude} />}
      <Text style={[s.pname, p.id === projectId && { color: C.text }]}
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
            <ScrollView style={s.sidebar} contentContainerStyle={{ padding: 6 }}>
              {projects.map((p) => projectRow(p, false))}
            </ScrollView>
          )}
          <View style={{ flex: 1 }}>
            {/* narrow: project chip strip stays in sight above the terminal */}
            {!wide && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false}
                style={s.pstrip} contentContainerStyle={s.pstripInner}>
                {projects.map((p) => projectRow(p, true))}
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
              <Pressable style={[s.kbtn, s.kwide]} onPress={paste}>
                <Text style={s.klabel}>📋 Paste</Text>
              </Pressable>
              <Pressable style={[s.kbtn, s.kwide]} onPress={() => js('TC.blurKeyboard()')}>
                <Text style={s.klabel}>⌨ Hide</Text>
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
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
    width: 190, flexGrow: 0, backgroundColor: C.bg,
    borderRightWidth: 1, borderRightColor: C.border,
  },
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
  kwide: { paddingHorizontal: 14 },
  klabel: { color: C.text, fontSize: 14 },
  sep: { width: 1, height: 24, backgroundColor: C.border, marginHorizontal: 4 },
});
