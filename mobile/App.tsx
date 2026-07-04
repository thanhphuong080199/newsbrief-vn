import { useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import FeedScreen from "./screens/FeedScreen";
import SourcesScreen from "./screens/SourcesScreen";

type Tab = "feed" | "sources";

// SafeAreaProvider must wrap the tree so SafeAreaView can read real device insets
// (react-native's own SafeAreaView is a no-op on Android — status/nav bars overlap).
export default function App() {
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}

function Root() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("feed");

  useEffect(() => {
    // No login screen: identity is a per-device anonymous Supabase user whose
    // session lives in AsyncStorage. On first launch (no stored session) we sign
    // in anonymously; every later launch reuses the same anonymous user id.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));

    supabase.auth.getSession().then(async ({ data }) => {
      if (data.session) {
        setSession(data.session);
      } else {
        const { data: anon, error } = await supabase.auth.signInAnonymously();
        if (error) setAuthError(error.message);
        else setSession(anon.session);
      }
      setReady(true);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  if (!ready || !session) {
    return (
      <SafeAreaView style={[styles.safe, styles.center]}>
        {authError ? (
          <Text style={styles.error}>Không thể khởi tạo: {authError}</Text>
        ) : (
          <ActivityIndicator color="#b91c1c" />
        )}
        <StatusBar style="dark" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>newsbrief</Text>
      </View>
      <View style={styles.body}>
        {tab === "feed" ? (
          <FeedScreen userId={session.user.id} />
        ) : (
          <SourcesScreen userId={session.user.id} />
        )}
      </View>
      <View style={styles.tabBar}>
        <TouchableOpacity style={styles.tabButton} onPress={() => setTab("feed")}>
          <Text style={[styles.tabLabel, tab === "feed" && styles.tabActive]}>Tin tức</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tabButton} onPress={() => setTab("sources")}>
          <Text style={[styles.tabLabel, tab === "sources" && styles.tabActive]}>Nguồn</Text>
        </TouchableOpacity>
      </View>
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#fff" },
  center: { justifyContent: "center", alignItems: "center", padding: 24 },
  error: { color: "#b91c1c", textAlign: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ddd",
  },
  headerTitle: { fontSize: 20, fontWeight: "800", color: "#b91c1c" },
  body: { flex: 1 },
  tabBar: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#ddd",
    backgroundColor: "#fff",
  },
  tabButton: { flex: 1, alignItems: "center", paddingVertical: 12 },
  tabLabel: { fontSize: 15, color: "#999", fontWeight: "600" },
  tabActive: { color: "#b91c1c" },
});
