import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { supabase } from "../lib/supabase";
import { Source } from "../lib/types";

// Fields the add-source modal collects. `isFeed` decides whether the URL is a
// direct RSS feed (feed_url) or a homepage the ingest job discovers/scrapes.
interface AddForm {
  name: string;
  url: string;
  lang: "vi" | "en";
  isFeed: boolean;
}

const EMPTY_FORM: AddForm = { name: "", url: "", lang: "vi", isFeed: false };

export default function SourcesScreen({ userId }: { userId: string }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [subscribed, setSubscribed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<AddForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const [sourcesRes, subsRes] = await Promise.all([
      supabase.from("sources").select("*").eq("active", true).order("name"),
      supabase.from("user_sources").select("source_id").eq("user_id", userId),
    ]);
    if (sourcesRes.error) {
      setError(sourcesRes.error.message);
      return;
    }
    setSources((sourcesRes.data ?? []) as Source[]);
    setSubscribed(new Set((subsRes.data ?? []).map((s) => s.source_id)));
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(sourceId: string, on: boolean) {
    setSubscribed((prev) => {
      const next = new Set(prev);
      if (on) next.add(sourceId);
      else next.delete(sourceId);
      return next;
    });
    if (on) {
      await supabase.from("user_sources").insert({ user_id: userId, source_id: sourceId });
    } else {
      await supabase.from("user_sources").delete().eq("user_id", userId).eq("source_id", sourceId);
    }
  }

  async function addSource() {
    const name = form.name.trim();
    let url = form.url.trim();
    if (!name || !url) {
      setError("Cần nhập cả tên và địa chỉ.");
      return;
    }
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try {
      // Validate the URL client-side before hitting the DB.
      new URL(url);
    } catch {
      setError("Địa chỉ không hợp lệ.");
      return;
    }
    setSaving(true);
    setError(null);
    // A direct feed goes in feed_url; otherwise it's a homepage the ingest job
    // discovers a feed from (falling back to page extraction).
    const { data, error: insErr } = await supabase
      .from("sources")
      .insert({
        name,
        homepage_url: form.isFeed ? null : url,
        feed_url: form.isFeed ? url : null,
        fetch_method: "rss",
        lang: form.lang,
        is_predefined: false,
        added_by: userId,
      })
      .select("id")
      .single();
    setSaving(false);
    if (insErr) {
      // feed_url is UNIQUE — a duplicate feed is the most likely failure.
      setError(
        insErr.code === "23505" ? "Nguồn này (feed) đã tồn tại." : insErr.message,
      );
      return;
    }
    // Auto-subscribe the creator to their new source.
    if (data?.id) {
      await supabase.from("user_sources").insert({ user_id: userId, source_id: data.id });
    }
    setForm(EMPTY_FORM);
    setAdding(false);
    await load();
  }

  function confirmDelete(source: Source) {
    Alert.alert(
      "Xóa nguồn",
      `Xóa "${source.name}"? Nguồn sẽ bị gỡ khỏi tất cả người dùng.`,
      [
        { text: "Hủy", style: "cancel" },
        {
          text: "Xóa",
          style: "destructive",
          onPress: async () => {
            const { error: delErr } = await supabase.from("sources").delete().eq("id", source.id);
            if (delErr) setError(delErr.message);
            else await load();
          },
        },
      ],
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <Text style={styles.hint}>
          Chưa chọn nguồn nào = hiển thị tất cả. Bật nguồn để chỉ xem tin từ các nguồn đã chọn.
        </Text>
        <TouchableOpacity style={styles.addButton} onPress={() => setAdding(true)}>
          <Text style={styles.addButtonText}>+ Thêm</Text>
        </TouchableOpacity>
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
      <FlatList
        data={sources}
        keyExtractor={(s) => s.id}
        renderItem={({ item }) => {
          const own = !item.is_predefined && item.added_by === userId;
          return (
            <View style={styles.row}>
              <TouchableOpacity
                style={styles.rowText}
                disabled={!own}
                onLongPress={() => own && confirmDelete(item)}
              >
                <Text style={styles.name}>{item.name}</Text>
                <Text style={styles.meta}>
                  {item.lang.toUpperCase()}
                  {item.is_predefined ? "" : own ? " · nguồn của bạn · giữ để xóa" : " · nguồn tự thêm"}
                </Text>
              </TouchableOpacity>
              <Switch
                value={subscribed.has(item.id)}
                onValueChange={(on) => toggle(item.id, on)}
                trackColor={{ true: "#b91c1c" }}
              />
            </View>
          );
        }}
      />

      <Modal
        visible={adding}
        transparent
        animationType="fade"
        onRequestClose={() => setAdding(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Thêm nguồn</Text>
            <TextInput
              style={styles.input}
              placeholder="Tên nguồn"
              value={form.name}
              onChangeText={(t) => setForm((f) => ({ ...f, name: t }))}
            />
            <TextInput
              style={styles.input}
              placeholder="Địa chỉ (URL trang chủ hoặc RSS)"
              autoCapitalize="none"
              keyboardType="url"
              value={form.url}
              onChangeText={(t) => setForm((f) => ({ ...f, url: t }))}
            />
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Đây là địa chỉ RSS feed</Text>
              <Switch
                value={form.isFeed}
                onValueChange={(v) => setForm((f) => ({ ...f, isFeed: v }))}
                trackColor={{ true: "#b91c1c" }}
              />
            </View>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Nguồn tiếng Anh (dịch sang tiếng Việt)</Text>
              <Switch
                value={form.lang === "en"}
                onValueChange={(v) => setForm((f) => ({ ...f, lang: v ? "en" : "vi" }))}
                trackColor={{ true: "#b91c1c" }}
              />
            </View>
            <View style={styles.modalActions}>
              <TouchableOpacity onPress={() => setAdding(false)} disabled={saving} hitSlop={8}>
                <Text style={styles.cancel}>Hủy</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.saveButton} onPress={addSource} disabled={saving}>
                <Text style={styles.saveButtonText}>Thêm</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f4f4f5" },
  topBar: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 4,
    gap: 10,
  },
  hint: { flex: 1, color: "#666", fontSize: 13 },
  addButton: {
    backgroundColor: "#b91c1c",
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  addButtonText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    marginHorizontal: 12,
    marginTop: 8,
    borderRadius: 12,
    padding: 14,
  },
  rowText: { flex: 1 },
  name: { fontSize: 16, fontWeight: "600" },
  meta: { color: "#999", fontSize: 12, marginTop: 2 },
  error: { color: "#b91c1c", textAlign: "center", marginTop: 8, paddingHorizontal: 12 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: { backgroundColor: "#fff", borderRadius: 14, padding: 18 },
  modalTitle: { fontSize: 17, fontWeight: "700", marginBottom: 14 },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    marginBottom: 12,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
    gap: 12,
  },
  switchLabel: { flex: 1, fontSize: 14, color: "#333" },
  modalActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 18,
    marginTop: 4,
  },
  cancel: { color: "#666", fontSize: 15 },
  saveButton: { backgroundColor: "#b91c1c", borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20 },
  saveButtonText: { color: "#fff", fontWeight: "700", fontSize: 15 },
});
