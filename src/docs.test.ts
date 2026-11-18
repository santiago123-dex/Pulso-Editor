import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Monaco y el sistema de archivos simulados ----
const h = vi.hoisted(() => {
  class FakeModel {
    text: string;
    alt = 1;
    disposed = false;
    listeners: (() => void)[] = [];
    constructor(text: string) { this.text = text; }
    getValue() { return this.text; }
    getAlternativeVersionId() { return this.alt; }
    getFullModelRange() { return { full: true }; }
    pushEditOperations(_s: unknown, ops: { text: string }[]) {
      if (ops[0].text !== this.text) {
        this.text = ops[0].text;
        this.alt++;
        this.listeners.forEach((f) => f());
      }
      return null;
    }
    onDidChangeContent(f: () => void) { this.listeners.push(f); }
    updateOptions() {}
    dispose() { this.disposed = true; }
  }

  type Backup = { path: string; contents: string; base_mtime: number; saved_at: number };
  const fsys = new Map<string, { text: string; mtime: number }>();
  const backups = new Map<string, Backup>();
  const clock = { now: 1000 };
  const calls: [string, any][] = [];
  const dialog = { answers: [] as string[], shown: [] as any[] };

  const invoke = async (cmd: string, args: any) => {
    calls.push([cmd, args]);
    switch (cmd) {
      case "read_file": {
        const f = fsys.get(args.path);
        if (!f) throw "No such file";
        return f.text;
      }
      case "file_mtime": {
        const f = fsys.get(args.path);
        if (!f) throw "No such file";
        return f.mtime;
      }
      case "write_file": {
        const cur = fsys.get(args.path);
        if (args.expectedMtime != null && cur && cur.mtime !== args.expectedMtime) throw "CONFLICT";
        clock.now += 10;
        fsys.set(args.path, { text: args.contents, mtime: clock.now });
        return clock.now;
      }
      case "backup_write":
        backups.set(args.path, { path: args.path, contents: args.contents, base_mtime: args.baseMtime, saved_at: Date.now() });
        return;
      case "backup_remove": backups.delete(args.path); return;
      case "backup_list": return Array.from(backups.values());
      default: throw new Error("comando no simulado: " + cmd);
    }
  };

  return { FakeModel, fsys, backups, clock, calls, dialog, invoke };
});

vi.mock("monaco-editor", () => ({
  editor: { createModel: (text: string) => new h.FakeModel(text) },
  Uri: { file: (p: string) => ({ path: p }) },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => h.invoke(cmd, args) }));
vi.mock("./settings", () => ({ state: { settings: { autoSave: false, tabSize: 2 } } }));
vi.mock("./ui", () => ({
  setStatus: vi.fn(),
  showDialog: vi.fn(async (o: unknown) => { h.dialog.shown.push(o); return h.dialog.answers.shift() ?? "cancel"; }),
}));

import {
  checkExternal, cloneDoc, disposeDoc, docs, flushBackups, isDirty, loadDoc, offerRecovery, onDocsChange, reloadDoc, removeBackup, restoreFromBackup, saveDoc, setBeforeSave,
} from "./docs";

const P = "C:/proyecto/a.ts";
const model = (path: string) => docs.get(path)!.model as unknown as InstanceType<typeof h.FakeModel>;
const edit = (path: string, text: string) => model(path).pushEditOperations(null, [{ text }]);
const disk = (path: string) => h.fsys.get(path)!;
const externalWrite = (path: string, text: string) => { h.clock.now += 500; h.fsys.set(path, { text, mtime: h.clock.now }); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  h.fsys.clear(); h.backups.clear(); h.calls.length = 0;
  h.dialog.answers = []; h.dialog.shown = [];
  h.clock.now = 1000;
  h.fsys.set(P, { text: "uno", mtime: 1000 });
  for (const k of Array.from(docs.keys())) disposeDoc(k);
  h.backups.clear();
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("guardar", () => {
  it("avisa a la interfaz solo cuando cambia el estado de guardado, sin perder la recuperación", async () => {
    const changed = vi.fn(); onDocsChange(changed);
    const d = await loadDoc(P);
    edit(P, "dos"); edit(P, "tres"); edit(P, "cuatro");
    expect(changed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.backups.get(P)?.contents).toBe("cuatro");
    await saveDoc(d);
    expect(changed).toHaveBeenCalledTimes(2);
    edit(P, "cinco");
    expect(changed).toHaveBeenCalledTimes(3);
  });
  it("actualiza la interfaz cuando deshacer vuelve a la versión guardada", async () => {
    const changed = vi.fn(); onDocsChange(changed);
    const d = await loadDoc(P);
    edit(P, "dos");
    const fake = model(P); fake.text = "uno"; fake.alt = 1; fake.listeners.forEach(f => f());
    expect(isDirty(d)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
  });
  it("reutiliza el documento cuando Windows devuelve otra capitalización o barras", async () => {
    const first = await loadDoc(P);
    const second = await loadDoc("c:\\PROYECTO\\A.ts");
    expect(second).toBe(first);
    expect(docs.size).toBe(1);
  });

  it("agrupa aperturas simultáneas de la misma ruta de Windows", async () => {
    const [first, second] = await Promise.all([loadDoc(P), loadDoc("c:\\PROYECTO\\A.ts")]);
    expect(second).toBe(first);
    expect(h.calls.filter(([name]) => name === "read_file")).toHaveLength(1);
  });
  it("escribe en disco, limpia el estado sucio y actualiza la fecha conocida", async () => {
    const d = await loadDoc(P);
    edit(P, "dos");
    expect(isDirty(d)).toBe(true);
    expect(await saveDoc(d)).toBe(true);
    expect(disk(P).text).toBe("dos");
    expect(isDirty(d)).toBe(false);
    expect(d.mtime).toBe(disk(P).mtime);
  });

  it("manda la fecha esperada para que el backend detecte cambios externos", async () => {
    const d = await loadDoc(P);
    edit(P, "dos");
    await saveDoc(d);
    const write = h.calls.find(([c]) => c === "write_file")![1];
    expect(write.expectedMtime).toBe(1000);
  });

  it("ante un conflicto y 'Cancelar' no toca el disco y deja el archivo sucio", async () => {
    const d = await loadDoc(P);
    edit(P, "mio");
    externalWrite(P, "externo");
    h.dialog.answers = ["cancel"];
    expect(await saveDoc(d)).toBe(false);
    expect(disk(P).text).toBe("externo");
    expect(isDirty(d)).toBe(true);
    expect(model(P).getValue()).toBe("mio");
  });

  it("ante un conflicto y 'Sobrescribir' guarda lo del editor", async () => {
    const d = await loadDoc(P);
    edit(P, "mio");
    externalWrite(P, "externo");
    h.dialog.answers = ["overwrite"];
    expect(await saveDoc(d)).toBe(true);
    expect(disk(P).text).toBe("mio");
    expect(isDirty(d)).toBe(false);
  });

  it("ante un conflicto y 'Cargar del disco' reemplaza el contenido y no guarda", async () => {
    const d = await loadDoc(P);
    edit(P, "mio");
    externalWrite(P, "externo");
    h.dialog.answers = ["reload"];
    expect(await saveDoc(d)).toBe(false);
    expect(model(P).getValue()).toBe("externo");
    expect(isDirty(d)).toBe(false);
  });

  it("si solo cambió la fecha (mismo contenido) guarda sin preguntar", async () => {
    const d = await loadDoc(P);
    const original = disk(P).text;
    edit(P, "mio");
    externalWrite(P, original);
    expect(await saveDoc(d)).toBe(true);
    expect(h.dialog.shown.length).toBe(0);
    expect(disk(P).text).toBe("mio");
  });

  it("si el contenido del disco cambió de verdad sigue avisando aunque tenga la misma longitud", async () => {
    const d = await loadDoc(P);
    const original = disk(P).text;
    edit(P, "mio");
    externalWrite(P, original.replace(/./, (c) => (c === "x" ? "y" : "x")));
    h.dialog.answers = ["cancel"];
    expect(await saveDoc(d)).toBe(false);
    expect(h.dialog.shown.length).toBe(1);
  });

  it("después de guardar, un cambio de fecha con el mismo contenido tampoco molesta", async () => {
    const d = await loadDoc(P);
    edit(P, "guardado");
    await saveDoc(d);
    externalWrite(P, "guardado");
    edit(P, "guardado y más");
    expect(await saveDoc(d)).toBe(true);
    expect(h.dialog.shown.length).toBe(0);
  });

  it("no apila diálogos si se guarda varias veces durante un mismo conflicto", async () => {
    const d = await loadDoc(P);
    edit(P, "mio");
    externalWrite(P, "externo");
    let release!: (v: string) => void;
    const { showDialog } = await import("./ui");
    vi.mocked(showDialog).mockImplementationOnce(() => new Promise<string>((r) => { release = r; }));
    const first = saveDoc(d);
    await vi.advanceTimersByTimeAsync(0);
    const second = await saveDoc(d);
    expect(second).toBe(false);
    expect(h.dialog.shown.length).toBe(0);
    release("cancel");
    await first;
  });

  it("un error distinto de conflicto se informa y no cambia el estado", async () => {
    const d = await loadDoc(P);
    edit(P, "dos");
    const orig = h.invoke;
    (h as any).invoke = async (c: string, a: any) => { if (c === "write_file") throw "Acceso denegado"; return orig(c, a); };
    expect(await saveDoc(d)).toBe(false);
    expect(isDirty(d)).toBe(true);
    (h as any).invoke = orig;
  });
});

describe("formatear al guardar", () => {
  afterEach(() => { setBeforeSave(null); });

  it("con la opción activa formatea antes de escribir y guarda el texto formateado", async () => {
    const { state } = await import("./settings");
    (state.settings as any).formatOnSave = true;
    try {
      const d = await loadDoc(P);
      edit(P, "sin   formato");
      setBeforeSave(async (doc) => { (doc.model as any).pushEditOperations([], [{ text: "con formato" }], () => null); });
      expect(await saveDoc(d)).toBe(true);
      expect(disk(P).text).toBe("con formato");
    } finally { (state.settings as any).formatOnSave = false; }
  });

  it("no formatea en el autoguardado ni con la opción apagada", async () => {
    const { state } = await import("./settings");
    const d = await loadDoc(P);
    let calls = 0;
    setBeforeSave(async () => { calls++; });
    edit(P, "uno");
    await saveDoc(d);
    (state.settings as any).formatOnSave = true;
    try {
      edit(P, "dos");
      await saveDoc(d, false, false, true);
    } finally { (state.settings as any).formatOnSave = false; }
    expect(calls).toBe(0);
  });

  it("si el formateo falla igualmente guarda lo escrito", async () => {
    const { state } = await import("./settings");
    (state.settings as any).formatOnSave = true;
    try {
      const d = await loadDoc(P);
      edit(P, "texto propio");
      setBeforeSave(async () => { throw new Error("servidor caído"); });
      expect(await saveDoc(d)).toBe(true);
      expect(disk(P).text).toBe("texto propio");
    } finally { (state.settings as any).formatOnSave = false; }
  });
});

describe("copias de recuperación", () => {
  it("guarda una copia del texto sucio tras una pausa, no en cada tecla", async () => {
    await loadDoc(P);
    edit(P, "a");
    edit(P, "ab");
    edit(P, "abc");
    expect(h.backups.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.backups.get(P)?.contents).toBe("abc");
    expect(h.calls.filter(([c]) => c === "backup_write").length).toBe(1);
    expect(h.backups.get(P)?.base_mtime).toBe(1000);
  });

  it("al perder el foco escribe la copia pendiente sin esperar la pausa", async () => {
    await loadDoc(P);
    edit(P, "recién escrito");
    expect(h.backups.has(P)).toBe(false);
    flushBackups();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.backups.get(P)?.contents).toBe("recién escrito");
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.calls.filter(([c]) => c === "backup_write").length).toBe(1);
  });

  it("guardar el archivo borra su copia", async () => {
    const d = await loadDoc(P);
    edit(P, "dos");
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.backups.has(P)).toBe(true);
    await saveDoc(d);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.backups.has(P)).toBe(false);
  });

  it("si lo escrito vuelve a ser igual a lo guardado, no deja copia", async () => {
    const d = await loadDoc(P);
    edit(P, "dos");
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.backups.has(P)).toBe(true);
    d.savedVersion = model(P).getAlternativeVersionId();
    edit(P, "dos");
    model(P).listeners.forEach((f) => f());
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.backups.has(P)).toBe(false);
  });

  it("descartar a propósito (cerrar el documento) borra la copia", async () => {
    await loadDoc(P);
    edit(P, "dos");
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.backups.has(P)).toBe(true);
    disposeDoc(P);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.backups.has(P)).toBe(false);
  });

  it("un archivo limpio nunca genera copias", async () => {
    await loadDoc(P);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.backups.size).toBe(0);
  });

  it("también protege archivos grandes", async () => {
    await loadDoc(P);
    edit(P, "x".repeat(5_000_001));
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.backups.get(P)?.contents.length).toBe(5_000_001);
  });

  it("actualiza la copia durante escritura continua sin esperar una pausa", async () => {
    await loadDoc(P);
    edit(P, "primero");
    await vi.advanceTimersByTimeAsync(800);
    edit(P, "segundo");
    await vi.advanceTimersByTimeAsync(250);
    expect(h.backups.get(P)?.contents).toBe("segundo");
  });

  it("agrupa copias pendientes durante escritura lenta y conserva el contenido más reciente", async () => {
    await loadDoc(P);
    const snapshot = vi.spyOn(model(P), "getValue");
    const orig = h.invoke;
    let release!: () => void, started!: () => void;
    const pending = new Promise<void>(r => { release = r; });
    const ready = new Promise<void>(r => { started = r; });
    let writes = 0;
    (h as any).invoke = async (c: string, a: any) => {
      if (c === "backup_write" && ++writes === 1) { started(); await pending; }
      return orig(c, a);
    };
    try {
      edit(P, "primero"); vi.advanceTimersByTime(1000); await ready;
      for (const text of ["dos", "tres", "cuatro"]) { edit(P, text); vi.advanceTimersByTime(1000); await Promise.resolve(); }
      expect(writes).toBe(1);
      release();
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(h.backups.get(P)?.contents).toBe("cuatro");
      expect(writes).toBe(2);
      expect(snapshot).toHaveBeenCalledTimes(2);
    } finally { release(); (h as any).invoke = orig; }
  });

  it("conserva una edición posterior al borrado aunque haya copias anteriores en cola", async () => {
    await loadDoc(P);
    const orig = h.invoke;
    let release!: () => void, started!: () => void;
    const pending = new Promise<void>(r => { release = r; });
    const ready = new Promise<void>(r => { started = r; });
    let writes = 0;
    (h as any).invoke = async (c: string, a: any) => {
      if (c === "backup_write" && ++writes === 1) { started(); await pending; }
      return orig(c, a);
    };
    try {
      edit(P, "primero"); vi.advanceTimersByTime(1000); await ready;
      edit(P, "segundo"); vi.advanceTimersByTime(1000);
      const removed = removeBackup(P);
      edit(P, "tercero"); vi.advanceTimersByTime(1000);
      release(); await removed;
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(h.backups.get(P)?.contents).toBe("tercero");
    } finally { release(); (h as any).invoke = orig; }
  });

  it("informa si falla una copia de recuperación", async () => {
    await loadDoc(P);
    const orig = h.invoke;
    const { setStatus } = await import("./ui");
    vi.mocked(setStatus).mockClear();
    (h as any).invoke = async (c: string, a: any) => {
      if (c === "backup_write") throw "disco lleno";
      return orig(c, a);
    };
    try {
      edit(P, "pendiente");
      await vi.advanceTimersByTimeAsync(1100);
      expect(setStatus).toHaveBeenCalledWith(expect.stringContaining("disco lleno"), 10000);
    } finally { (h as any).invoke = orig; }
  });

  it("espera una copia en curso antes de eliminarla al guardar", async () => {
    const d = await loadDoc(P);
    const orig = h.invoke;
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((r) => { release = r; });
    const ready = new Promise<void>((r) => { started = r; });
    (h as any).invoke = async (c: string, a: any) => {
      if (c === "backup_write") { started(); await pending; }
      return orig(c, a);
    };
    try {
      edit(P, "pendiente");
      await vi.advanceTimersByTimeAsync(1000);
      await ready;
      const saving = saveDoc(d);
      await Promise.resolve();
      release();
      expect(await saving).toBe(true);
      expect(h.backups.has(P)).toBe(false);
    } finally { (h as any).invoke = orig; }
  });

  it("no considera terminado el guardado si se editó durante la escritura", async () => {
    const d = await loadDoc(P);
    const orig = h.invoke;
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((r) => { release = r; });
    const ready = new Promise<void>((r) => { started = r; });
    (h as any).invoke = async (c: string, a: any) => {
      if (c === "write_file") { started(); await pending; }
      return orig(c, a);
    };
    try {
      edit(P, "primero");
      const saving = saveDoc(d);
      await ready;
      edit(P, "segundo");
      release();
      expect(await saving).toBe(false);
      expect(isDirty(d)).toBe(true);
      expect(disk(P).text).toBe("primero");
    } finally { (h as any).invoke = orig; }
  });
});

describe("recuperar tras un cierre inesperado", () => {
  const backup = (path: string, contents: string, base = 1000) => {
    h.backups.set(path, { path, contents, base_mtime: base, saved_at: Date.now() - 120_000 });
  };

  it("sin copias pendientes no pregunta nada", async () => {
    await offerRecovery(async () => {});
    expect(h.dialog.shown.length).toBe(0);
  });

  it("'Restaurar' devuelve el texto, lo deja sucio y abre el archivo", async () => {
    backup(P, "trabajo sin guardar");
    h.dialog.answers = ["restore"];
    const opened: string[] = [];
    await offerRecovery(async (p) => { opened.push(p); });
    expect(h.dialog.shown[0].message).toContain("a.ts");
    expect(opened).toEqual([P]);
    expect(model(P).getValue()).toBe("trabajo sin guardar");
    expect(isDirty(docs.get(P)!)).toBe(true);
    expect(disk(P).text).toBe("uno");
  });

  it("'Descartar' borra las copias sin tocar los archivos", async () => {
    backup(P, "x");
    h.dialog.answers = ["discard"];
    await offerRecovery(async () => {});
    expect(h.backups.size).toBe(0);
    expect(disk(P).text).toBe("uno");
  });

  it("'Más tarde' conserva las copias para el próximo inicio", async () => {
    backup(P, "x");
    h.dialog.answers = ["later"];
    await offerRecovery(async () => {});
    expect(h.backups.size).toBe(1);
  });

  it("restaura un archivo que ya no existe como documento sin guardar", async () => {
    const gone = "C:/proyecto/borrado.ts";
    const d = await restoreFromBackup({ path: gone, contents: "contenido", base_mtime: 5, saved_at: 0 });
    expect(model(gone).getValue()).toBe("contenido");
    expect(isDirty(d)).toBe(true);
    expect(await saveDoc(d)).toBe(true);
    expect(disk(gone).text).toBe("contenido");
  });

  it("si el disco cambió desde la copia, guardar avisa del conflicto en vez de pisarlo", async () => {
    backup(P, "mi trabajo", 1000);
    externalWrite(P, "otro programa");
    const d = await restoreFromBackup(h.backups.get(P)!);
    h.dialog.answers = ["cancel"];
    expect(await saveDoc(d)).toBe(false);
    expect(disk(P).text).toBe("otro programa");
  });

  it("restaurar un texto idéntico al del disco no deja el archivo sucio ni la copia", async () => {
    backup(P, "uno");
    const d = await restoreFromBackup(h.backups.get(P)!);
    await vi.advanceTimersByTimeAsync(0);
    expect(isDirty(d)).toBe(false);
    expect(h.backups.has(P)).toBe(false);
  });
});

describe("cambios externos y renombrado", () => {
  it("un archivo con cambios propios cuya fecha cambió sin cambiar el contenido no pregunta", async () => {
    await loadDoc(P);
    edit(P, "mio");
    externalWrite(P, disk(P).text);
    await checkExternal();
    expect(h.dialog.shown.length).toBe(0);
    expect(model(P).getValue()).toBe("mio");
  });

  it("recarga en silencio un archivo limpio que cambió en el disco", async () => {
    await loadDoc(P);
    externalWrite(P, "nuevo en disco");
    await checkExternal();
    expect(model(P).getValue()).toBe("nuevo en disco");
    expect(isDirty(docs.get(P)!)).toBe(false);
    expect(h.dialog.shown.length).toBe(0);
  });

  it("con cambios propios pregunta y respeta 'Mantener los míos'", async () => {
    await loadDoc(P);
    edit(P, "mio");
    externalWrite(P, "externo");
    h.dialog.answers = ["keep"];
    await checkExternal();
    expect(model(P).getValue()).toBe("mio");
    expect(h.dialog.shown.length).toBe(1);
  });

  it("con cambios propios y 'Recargar' toma lo del disco", async () => {
    await loadDoc(P);
    edit(P, "mio");
    externalWrite(P, "externo");
    h.dialog.answers = ["reload"];
    await checkExternal();
    expect(model(P).getValue()).toBe("externo");
  });

  it("recargar conserva la posibilidad de deshacer (no recrea el modelo)", async () => {
    const d = await loadDoc(P);
    const before = d.model;
    externalWrite(P, "otro");
    await reloadDoc(P);
    expect(docs.get(P)!.model).toBe(before);
  });

  it("renombrar conserva el contenido y el estado sucio", async () => {
    const d = await loadDoc(P);
    edit(P, "pendiente");
    const nd = cloneDoc(d, "C:/proyecto/b.ts");
    expect(nd.model.getValue()).toBe("pendiente");
    expect(isDirty(nd)).toBe(true);
    const clean = await loadDoc("C:/proyecto/c.ts").catch(() => null);
    expect(clean).toBeNull();
  });

  it("renombrar un archivo limpio lo deja limpio", async () => {
    const d = await loadDoc(P);
    const nd = cloneDoc(d, "C:/proyecto/b.ts");
    expect(isDirty(nd)).toBe(false);
  });
});
