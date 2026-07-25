// JS surface for the native drop-target module. Loaded defensively like the
// other tc-* modules: binaries without it (or non-iOS platforms) get null
// and the app renders a plain View instead — drops just do nothing there.
import { requireNativeModule, requireNativeViewManager } from 'expo-modules-core';
import type * as React from 'react';
import type { ViewProps } from 'react-native';

export type DropEvent = { nativeEvent: { name: string; path: string } };
export type TCDropZoneProps = ViewProps & {
  onDrop?: (e: DropEvent) => void;
};

let view: React.ComponentType<TCDropZoneProps> | null = null;
try {
  // requireNativeViewManager never throws — probe the module registry first
  requireNativeModule('TCDropZone');
  view = requireNativeViewManager<TCDropZoneProps>('TCDropZone');
} catch {
  // native module not present in this binary
}

export const TCDropZone = view;
