/**
 * Root layout: gesture root → theme → navigation stack.
 * Router chrome is disabled; screens render their own headers (Screen/Header)
 * so the design system owns every pixel.
 */
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { checkForUpdate, setPendingUpdate } from "../lib/updater";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import * as Notifications from "expo-notifications";

import { ProfilesProvider, useProfiles } from "../lib/profiles/ProfilesContext";
import { configureNotifications, ensureChannel } from "../lib/notificationPoster";
import { openChatWithBackStack, takePendingChatLink } from "../lib/chatDeepLink";
import { startBackgroundPollingForProfile } from "../lib/backgroundPolling";
import { ThemeProvider, useTheme } from "../theme/ThemeProvider";

/**
 * Root-level background polling lifecycle. The AppState listener lives here
 * (not in the chat screen) so backgrounding from ANY screen polls every
 * conversation whose notification mode resolves to ALL_MESSAGES.
 */
function BackgroundPollingLifecycle() {
  const { activeProfile } = useProfiles();
  const profileRef = useRef(activeProfile);
  useEffect(() => {
    profileRef.current = activeProfile;
  }, [activeProfile]);

  useEffect(() => {
    // The poller runs for the app's whole lifetime — foregrounded too — so
    // "All messages" notifications fire even while the app is open on another
    // screen. Per-conversation suppression is handled by setVisibleConversation.
    void startBackgroundPollingForProfile(profileRef.current);
    const sub = AppState.addEventListener("change", () => {
      void startBackgroundPollingForProfile(profileRef.current);
    });
    return () => sub.remove();
  }, [activeProfile]);

  return null;
}

const UPDATE_CHECK_KEY = "letta.update.lastCheck";
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h

/**
 * Checks for app updates on foreground, at most every 4h. Result is surfaced
 * through a module-level listener (the profile screen banner subscribes).
 */
function UpdateCheckLifecycle() {
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const last = Number((await AsyncStorage.getItem(UPDATE_CHECK_KEY)) ?? 0);
        if (Date.now() - last < UPDATE_CHECK_INTERVAL_MS) return;
        const result = await checkForUpdate();
        if (cancelled) return;
        if (result.updateAvailable) {
          setPendingUpdate({ version: result.manifest!.version, manifest: result.manifest! });
        }
        await AsyncStorage.setItem(UPDATE_CHECK_KEY, String(Date.now()));
      } catch {
        // Update checks are best-effort; never disturb the user.
      }
    };
    void run();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void run();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);
  return null;
}

function ThemedStack() {
  const { name, colors } = useTheme();
  return (
    <>
      <StatusBar style={name === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: "slide_from_right",
        }}
      />
    </>
  );
}

export default function RootLayout() {
  // Configure notifications once at app startup.
  useEffect(() => {
    void (async () => {
      await configureNotifications();
      await ensureChannel();
    })();
    // Cold-start deep link (conversation notification / shortcut): the
    // initial URL was redirected to "/" in +native-intent and the target
    // stashed. Rebuild the natural stack now that the navigator is ready.
    // This effect runs after the navigation container mounted (bottom-up
    // ordering), so the queued commands drain onto a ready container.
    const pending = takePendingChatLink();
    if (pending) {
      openChatWithBackStack(pending);
    }
    // Navigate to the conversation when a notification is tapped.
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as
        | { conversationId?: string; agentId?: string; agentName?: string }
        | undefined;
      if (data?.conversationId) {
        // Rebuild the natural stack (servers -> agents -> conversations ->
        // chat) so hardware back walks the chain instead of exiting the app.
        // Legacy notifications carry only conversationId — no agentId to
        // build the middle screens, so land on chat directly (old behavior).
        if (data.agentId) {
          openChatWithBackStack({
            conversationId: data.conversationId,
            agentId: data.agentId,
            agentName: data.agentName,
          });
        } else {
          // Same late-require pattern as before: _layout runs before the
          // router module would be safe to import at top level.
          const router = require("expo-router").router;
          router.push({
            pathname: "/chat",
            params: { conversationId: data.conversationId },
          });
        }
      }
    });
    return () => sub.remove();
  }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        <ProfilesProvider>
          <BackgroundPollingLifecycle />
      <UpdateCheckLifecycle />
          <BottomSheetModalProvider>
            <ThemedStack />
          </BottomSheetModalProvider>
        </ProfilesProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
