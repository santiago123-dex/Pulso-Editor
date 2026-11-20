import { describe, expect, it } from "vitest";
import type { Turn } from "./aiModel";
import { chatsFor, deleteChat, loadChats, MAX_BYTES, MAX_CHATS, mergeChats, newChatId, pickHistory, saveChat, titleFrom, type SavedChat, type Store } from "./aiStore";

const memory = (): Store & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
};
const turn = (role: "user" | "assistant", text: string): Turn => ({ id: role, role, blocks: [{ kind: "text", text }], done: false });
const chat = (id: string, at: number, extra: Partial<SavedChat> = {}): SavedChat => ({ id, title: id, cwd: "C:/p", sessionId: "s", model: "", updatedAt: at, messages: [turn("user", "hola")], ...extra });

describe("titleFrom y newChatId", () => {
  it("usa el primer mensaje de la persona, en una línea y recortado", () => {
    expect(titleFrom([turn("user", "  Explícame\n esta   función ")])).toBe("Explícame esta función");
    expect(titleFrom([turn("user", "x".repeat(100))]).length).toBe(58);
    expect(titleFrom([])).toBe("Conversación nueva");
    expect(titleFrom([turn("assistant", "solo respuesta")])).toBe("Conversación nueva");
  });
  it("genera identificadores que la herramienta acepta (sin guion inicial ni espacios)", () => {
    const id = newChatId();
    expect(id).toMatch(/^c[a-z0-9]+$/);
    expect(newChatId(1, 0.1)).not.toBe(newChatId(2, 0.1));
  });
});

describe("guardar y cargar", () => {
  it("guarda, ordena por la más reciente y actualiza sin duplicar", () => {
    const s = memory();
    saveChat(chat("a", 1), s); saveChat(chat("b", 3), s); saveChat(chat("c", 2), s);
    saveChat(chat("a", 5, { title: "nuevo" }), s);
    expect(loadChats(s).map((c) => [c.id, c.title])).toEqual([["a", "nuevo"], ["b", "b"], ["c", "c"]]);
  });
  it("conserva como máximo 30 conversaciones", () => {
    const s = memory();
    for (let i = 0; i < MAX_CHATS + 5; i++) saveChat(chat(`c${i}`, i), s);
    const all = loadChats(s);
    expect(all).toHaveLength(MAX_CHATS);
    expect(all[0].id).toBe(`c${MAX_CHATS + 4}`);
  });
  it("recorta resultados largos de herramientas y marca los mensajes como terminados", () => {
    const s = memory();
    const big: Turn = { id: "a", role: "assistant", done: false, blocks: [{ kind: "tool", id: "t", name: "Read", input: {}, json: "{}", result: "x".repeat(5000) }] };
    saveChat(chat("a", 1, { messages: [big] }), s);
    const saved = loadChats(s)[0].messages[0];
    expect(saved.done).toBe(true);
    const b = saved.blocks[0] as { result: string; json: string };
    expect(b.result.length).toBeLessThan(700);
    expect(b.json).toBe("");
  });
  it("si no cabe descarta las más antiguas pero nunca la que se guarda", () => {
    const s = memory();
    const fat = (id: string, at: number) => chat(id, at, { messages: [turn("user", "y".repeat(400_000))] });
    for (let i = 0; i < 6; i++) saveChat(fat(`f${i}`, i), s);
    const all = loadChats(s);
    expect(JSON.stringify(all).length).toBeLessThanOrEqual(MAX_BYTES);
    expect(all[0].id).toBe("f5");
    saveChat(chat("enorme", 99, { messages: [turn("user", "z".repeat(MAX_BYTES + 10))] }), s);
    expect(loadChats(s)[0].id).toBe("enorme");
  });
  it("borra una conversación y tolera datos corruptos o un almacén que falla", () => {
    const s = memory();
    saveChat(chat("a", 1), s); saveChat(chat("b", 2), s);
    deleteChat("a", s);
    expect(loadChats(s).map((c) => c.id)).toEqual(["b"]);
    s.setItem("pulso.ai.chats", "{no json");
    expect(loadChats(s)).toEqual([]);
    s.setItem("pulso.ai.chats", JSON.stringify([{ nada: 1 }, chat("ok", 1)]));
    expect(loadChats(s).map((c) => c.id)).toEqual(["ok"]);
    const roto: Store = { getItem: () => null, setItem: () => { throw new Error("lleno"); } };
    expect(() => saveChat(chat("a", 1), roto)).not.toThrow();
  });
});

describe("mergeChats", () => {
  it("conserva la versión más reciente al recuperar cierres en ejecución", () => {
    const merged = mergeChats([chat("a", 10, { title: "viejo" }), chat("b", 5)], [chat("a", 20, { title: "en curso" }), chat("c", 15)]);
    expect(merged.map((c) => [c.id, c.title])).toEqual([["a", "en curso"], ["c", "c"], ["b", "b"]]);
  });
});

describe("chatsFor", () => {
  it("filtra por carpeta sin distinguir mayúsculas, barras ni barra final", () => {
    const list = [chat("a", 1, { cwd: "C:/Proyecto/" }), chat("b", 2, { cwd: "C:/otro" })];
    expect(chatsFor(list, "c:\\proyecto").map((c) => c.id)).toEqual(["a"]);
    expect(chatsFor(list, "D:/x")).toEqual([]);
  });
});

describe("migración del historial a archivo", () => {
  const one = '[{"id":"a"}]';
  it("usa el archivo si ya tiene conversaciones", () => {
    expect(pickHistory(one, '[{"id":"viejo"}]')).toEqual({ text: one, migrated: false });
  });
  it("trae lo de localStorage la primera vez, y solo una vez", () => {
    expect(pickHistory("", one)).toEqual({ text: one, migrated: true });
    expect(pickHistory("[]", one)).toEqual({ text: one, migrated: true });
  });
  it("ignora contenido dañado o que no es una lista", () => {
    expect(pickHistory("{roto", "{}")).toEqual({ text: "[]", migrated: false });
    expect(pickHistory(null, null)).toEqual({ text: "[]", migrated: false });
  });
});
