// Project list for one box — mirrors the dashboard sidebar (color tag,
// claude-running dot), minus the editing chrome.
import { useCallback, useState } from 'react';
import {
  FlatList, Pressable, RefreshControl, StyleSheet, Text, View,
} from 'react-native';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ApiError, getProjects, Project } from '@/lib/api';
import { Box, getBox } from '@/lib/boxes';
import { C } from '@/lib/theme';

export default function Projects() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [box, setBox] = useState<Box | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const b = await getBox(id);
    if (!b) { router.back(); return; }
    setBox(b); setBusy(true);
    try {
      const data = await getProjects(b);
      setProjects(data.projects.filter((p) => !p.hidden));
      setErr('');
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 401
        ? 'Session expired — long-press the machine to log in again.'
        : 'Could not reach this machine.');
    } finally {
      setBusy(false);
    }
  }, [id]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  return (
    <View style={s.root}>
      <Stack.Screen options={{ title: box?.name ?? '…' }} />
      {!!err && <Text style={s.err}>{err}</Text>}
      <FlatList
        data={projects}
        keyExtractor={(p) => p.id}
        contentContainerStyle={{ padding: 12 }}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={load} tintColor={C.muted} />}
        renderItem={({ item }) => (
          <Pressable
            style={[s.card, { borderLeftColor: item.color ?? 'transparent' }]}
            onPress={() => router.push({
              pathname: '/term',
              params: { box: id, project: item.id, name: item.name },
            })}
          >
            {item.claude_running && <View style={s.claude} />}
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{item.name}</Text>
              <Text style={s.sub} numberOfLines={1}>{item.dir}</Text>
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  err: { color: C.amber, padding: 12, paddingBottom: 0 },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: C.panel, borderColor: C.border, borderWidth: 1,
    borderLeftWidth: 4, borderRadius: 10, padding: 13, marginBottom: 8,
  },
  claude: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.green },
  name: { color: C.text, fontSize: 14, fontWeight: '600' },
  sub: { color: C.muted, fontSize: 11.5, marginTop: 2 },
});
