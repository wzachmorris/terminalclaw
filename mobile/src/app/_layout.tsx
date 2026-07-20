import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { C } from '@/lib/theme';

export default function Layout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: C.panel },
          headerTintColor: C.text,
          headerTitleStyle: { fontSize: 16 },
          contentStyle: { backgroundColor: C.bg },
        }}
      />
    </>
  );
}
