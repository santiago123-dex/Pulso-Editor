import { describe, expect, it } from "vitest";
import { ago, buildItems, isChatRoom, dayLabel, insertMention, lastSpoke, mentionAt, mentionsPerson, mergeComments, splitBody, suggestMembers, unreadCount, type ChatComment } from "./chatModel";

const u = (login: string) => ({ login, avatar_url: `https://avatars.githubusercontent.com/${login}` });
const c = (id: number, login: string | null, iso: string, body = "hola"): ChatComment => ({ id, body, user: login ? u(login) : null, created_at: iso });
const NOW = Date.parse("2026-11-18T15:00:00");
const at = (hhmm: string, day = "2026-11-18") => `${day}T${hhmm}:00`;

describe("buildItems", () => {
  it("agrupa mensajes seguidos de la misma persona y marca cabecera y cola", () => {
    const items = buildItems([c(1, "ana", at("10:00")), c(2, "ana", at("10:02")), c(3, "bo", at("10:03")), c(4, "ana", at("10:04"))], "bo", NOW);
    const msgs = items.filter((i) => i.type === "msg") as Extract<(typeof items)[number], { type: "msg" }>[];
    expect(msgs.map((m) => [m.id, m.head, m.tail, m.mine])).toEqual([[1, true, false, false], [2, false, true, false], [3, true, true, true], [4, true, true, false]]);
  });
  it("una pausa larga abre un grupo nuevo aunque sea la misma persona", () => {
    const msgs = buildItems([c(1, "ana", at("10:00")), c(2, "ana", at("10:30"))], "x", NOW).filter((i) => i.type === "msg") as { head: boolean }[];
    expect(msgs.map((m) => m.head)).toEqual([true, true]);
  });
  it("pone un separador por día y no agrupa entre días", () => {
    const items = buildItems([c(1, "ana", at("23:58", "2026-11-17")), c(2, "ana", at("00:01", "2026-11-18"))], "x", NOW);
    expect(items.map((i) => (i.type === "day" ? i.label : `m${i.id}`))).toEqual(["Ayer", "m1", "Hoy", "m2"]);
    expect((items[3] as { head: boolean }).head).toBe(true);
  });
  it("compara el usuario sin distinguir mayúsculas y tolera usuarios eliminados", () => {
    const items = buildItems([c(1, "Ana", at("10:00")), c(2, null, at("10:01"))], "ana", NOW);
    expect((items[1] as { mine: boolean }).mine).toBe(true);
    expect((items[2] as { login: string; mine: boolean })).toMatchObject({ login: "usuario eliminado", mine: false });
  });
  it("sin comentarios no hay nada que pintar", () => { expect(buildItems([], "x", NOW)).toEqual([]); });
});

describe("isChatRoom", () => {
  it("reconoce la issue del chat por su etiqueta, sin distinguir mayúsculas", () => {
    expect(isChatRoom({ labels: [{ name: "bug" }, { name: "Pulso-Chat" }] })).toBe(true);
    expect(isChatRoom({ labels: [{ name: "bug" }] })).toBe(false);
    expect(isChatRoom({ labels: [] })).toBe(false);
  });
});

describe("dayLabel y ago", () => {
  it("Hoy, Ayer y una fecha larga", () => {
    expect(dayLabel(Date.parse(at("09:00")), NOW)).toBe("Hoy");
    expect(dayLabel(Date.parse(at("09:00", "2026-11-17")), NOW)).toBe("Ayer");
    expect(dayLabel(Date.parse(at("09:00", "2026-11-10")), NOW)).toMatch(/10/);
  });
  it("tiempo relativo", () => {
    expect(ago(NOW - 10_000, NOW)).toBe("hace un momento");
    expect(ago(NOW - 5 * 60_000, NOW)).toBe("hace 5 min");
    expect(ago(NOW - 3 * 3600_000, NOW)).toBe("hace 3 h");
    expect(ago(NOW - 2 * 86400_000, NOW)).toBe("hace 2 d");
  });
});

describe("mergeComments, unreadCount y lastSpoke", () => {
  it("junta por id, los nuevos sustituyen y queda ordenado", () => {
    const m = mergeComments([c(2, "a", at("10:00"), "viejo"), c(1, "a", at("09:00"))], [c(2, "a", at("10:00"), "editado"), c(3, "b", at("11:00"))]);
    expect(m.map((x) => [x.id, x.body])).toEqual([[1, "hola"], [2, "editado"], [3, "hola"]]);
  });
  it("no cuenta como nuevos los propios ni los ya vistos", () => {
    const list = [c(1, "ana", at("09:00")), c(2, "yo", at("09:01")), c(3, "bo", at("09:02")), c(4, "YO", at("09:03"))];
    expect(unreadCount(list, 1, "yo")).toBe(1);
    expect(unreadCount(list, 0, "yo")).toBe(2);
    expect(unreadCount(list, 99, "yo")).toBe(0);
  });
  it("recuerda cuándo escribió cada persona por última vez", () => {
    const m = lastSpoke([c(1, "Ana", at("09:00")), c(2, "ana", at("11:00")), c(3, "bo", at("10:00")), c(4, null, at("12:00"))]);
    expect(m.get("ana")).toBe(Date.parse(at("11:00")));
    expect(m.size).toBe(2);
  });
});

describe("splitBody y menciones", () => {
  it("separa texto, menciones y enlaces sin perder nada", () => {
    const parts = splitBody("Hola @ana, mira https://github.com/a/b/issues/1. Gracias");
    expect(parts.map((p) => p.kind)).toEqual(["text", "mention", "text", "link", "text"]);
    expect(parts.map((p) => p.text).join("")).toBe("Hola @ana, mira https://github.com/a/b/issues/1. Gracias");
    expect(parts[3].text).toBe("https://github.com/a/b/issues/1");
  });
  it("un correo no es una mención y el texto vacío no rompe", () => {
    expect(splitBody("escribe a ana@correo.com").some((p) => p.kind === "mention")).toBe(false);
    expect(splitBody("")).toEqual([]);
  });
  it("detecta si te mencionan", () => {
    expect(mentionsPerson("ping @Ana por favor", "ana")).toBe(true);
    expect(mentionsPerson("ping @anabel", "ana")).toBe(false);
    expect(mentionsPerson("nada", "ana")).toBe(false);
  });
  it("javascript: u otros esquemas no se tratan como enlace", () => {
    expect(splitBody("javascript:alert(1)").every((p) => p.kind === "text")).toBe(true);
  });
  it("reconoce referencias a #issues y archivo:línea sin confundir horas ni rutas con ..", () => {
    const parts = splitBody("Mira src/lsp.ts:42 y #128 a las 10:30, nunca ../secreto.ts:1");
    expect(parts.filter((p) => p.kind === "file")).toEqual([
      { text: "src/lsp.ts:42", kind: "file", path: "src/lsp.ts", line: 42 },
    ]);
    expect(parts.filter((p) => p.kind === "issue")).toEqual([
      { text: "#128", kind: "issue", issue: 128 },
    ]);
    expect(parts.map((p) => p.text).join("")).toBe("Mira src/lsp.ts:42 y #128 a las 10:30, nunca ../secreto.ts:1");
  });
});

describe("autocompletar @", () => {
  const members = [u("ana"), u("bruno"), u("Joana"), u("carla")];
  it("detecta la mención en curso en el cursor", () => {
    expect(mentionAt("hola @an", 8)).toEqual({ start: 5, query: "an" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionAt("hola ana", 8)).toBeNull();
    expect(mentionAt("correo a@b", 10)).toBeNull();
    expect(mentionAt("hola @ana y más", 9)).toEqual({ start: 5, query: "ana" });
  });
  it("sugiere primero las que empiezan por lo escrito", () => {
    expect(suggestMembers(members, "an").map((m) => m.login)).toEqual(["ana", "Joana"]);
    expect(suggestMembers(members, "").length).toBe(4);
    expect(suggestMembers(members, "zz")).toEqual([]);
  });
  it("inserta la mención y deja el cursor tras el espacio", () => {
    const q = mentionAt("hola @an y más", 8)!;
    expect(insertMention("hola @an y más", q, "ana")).toEqual({ text: "hola @ana  y más", caret: 10 });
  });
});
