import {
  ItemView,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  moment,
} from "obsidian";

/* ============================================================
 * 数据模型
 * ============================================================ */

/** 一个时间块。start / end 为距 0:00 的分钟数 */
interface Timeblock {
  start: number;
  end: number;
  title: string;
  category: string;
  goal: string;
  note: string;
  done: boolean;
}

/** 目标拆解出的一小步 */
interface GoalStep {
  text: string;
  done: boolean;
}

/** 一个目标 */
interface Goal {
  name: string;
  targetHours: number;
  due: string; // YYYY-MM-DD 或空
  status: string; // 进行中 / 已完成 / 暂停
  steps: GoalStep[];
}

const STEPS_HEADING = "## 目标拆解";

interface TimeblockSettings {
  scheduleFolder: string;
  goalsFile: string;
  startHour: number;
  endHour: number;
  pxPerHour: number;
}

const DEFAULT_SETTINGS: TimeblockSettings = {
  scheduleFolder: "时间块规划/日程",
  goalsFile: "时间块规划/目标库.md",
  startHour: 6,
  endHour: 24,
  pxPerHour: 72,
};

const VIEW_TYPE = "tbp-view";

const CATEGORIES = ["专注", "学习", "运动", "生活", "休息", "其他"] as const;

const CAT_CLASS: Record<string, string> = {
  专注: "tbp-cat-focus",
  学习: "tbp-cat-study",
  运动: "tbp-cat-sport",
  生活: "tbp-cat-life",
  休息: "tbp-cat-rest",
  其他: "tbp-cat-misc",
};

const GOAL_STATUS = ["进行中", "已完成", "暂停"] as const;

/* ============================================================
 * 工具函数
 * ============================================================ */

function fmtTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function fmtDuration(min: number): string {
  if (min <= 0) return "0h";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h${m}m`;
}

/** 清理用户输入，避免破坏行格式（| 与换行） */
function sanitize(s: string): string {
  return s.replace(/[|\r\n]/g, " ").trim();
}

/* ============================================================
 * Markdown 解析 / 序列化
 * ============================================================ */

const BLOCK_LINE_RE =
  /^-\s\[([ xX])\]\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*\|(.*)$/;

function parseBlockLine(line: string): Timeblock | null {
  const m = BLOCK_LINE_RE.exec(line.trim());
  if (!m) return null;
  const done = m[1].toLowerCase() === "x";
  const start = parseInt(m[2]) * 60 + parseInt(m[3]);
  const end = parseInt(m[4]) * 60 + parseInt(m[5]);
  const rest = m[6];
  const parts = rest.split("|").map((p) => p.trim());
  let title = "";
  let category = "其他";
  let goal = "";
  let note = "";
  for (const p of parts) {
    if (!p) continue;
    if (p.startsWith("分类:")) category = p.slice(3).trim() || "其他";
    else if (p.startsWith("目标:")) goal = p.slice(3).trim();
    else if (p.startsWith("备注:")) note = p.slice(3).trim();
    else if (!title) title = p;
  }
  if (!title) title = "未命名";
  return { start, end, title, category, goal, note, done };
}

function serializeBlock(b: Timeblock): string {
  let s = `- [${b.done ? "x" : " "}] ${fmtTime(b.start)} - ${fmtTime(b.end)} | ${b.title}`;
  if (b.category && b.category !== "其他") s += ` | 分类:${b.category}`;
  if (b.goal) s += ` | 目标:${b.goal}`;
  if (b.note) s += ` | 备注:${b.note}`;
  return s;
}

/** 从日笔记全文中提取时间块区段 */
function extractSection(content: string, heading: string): { body: string; startIdx: number; endIdx: number } | null {
  const lines = content.split("\n");
  const hIdx = lines.findIndex((l) => l.trim() === heading);
  if (hIdx === -1) return null;
  let end = lines.length;
  for (let i = hIdx + 1; i < lines.length; i++) {
    if (/^#{1,3}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { body: lines.slice(hIdx + 1, end).join("\n"), startIdx: hIdx + 1, endIdx: end };
}

function parseDayBlocks(content: string): Timeblock[] {
  const sec = extractSection(content, "## 时间块");
  if (!sec) return [];
  const blocks: Timeblock[] = [];
  for (const line of sec.body.split("\n")) {
    const b = parseBlockLine(line);
    if (b) blocks.push(b);
  }
  blocks.sort((a, b) => a.start - b.start);
  return blocks;
}

function dayTemplate(dateStr: string, blocks: Timeblock[]): string {
  let s = `# ${dateStr}\n\n## 时间块\n`;
  for (const b of blocks) s += serializeBlock(b) + "\n";
  s += "\n## 日复盘\n\n";
  return s;
}

/** 把时间块写回日笔记全文（无文件结构时自动补） */
function writeDayBlocks(content: string, blocks: Timeblock[]): string {
  blocks = [...blocks].sort((a, b) => a.start - b.start);
  const sec = extractSection(content, "## 时间块");
  if (!sec) {
    return content.replace(/\s*$/, "\n") + "\n## 时间块\n" + blocks.map(serializeBlock).join("\n") + "\n";
  }
  const lines = content.split("\n");
  const body = blocks.map(serializeBlock);
  const replaced = ["", ...body, ""];
  lines.splice(sec.startIdx, sec.endIdx - sec.startIdx, ...replaced);
  return lines.join("\n");
}

/* ---- 目标库 ---- */

/** 解析目标拆解区段：### 目标名 下的 - [ ] 步骤 */
function parseGoalSteps(content: string): Map<string, GoalStep[]> {
  const map = new Map<string, GoalStep[]>();
  let inSection = false;
  let current: string | null = null;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (/^##\s/.test(line)) {
      inSection = line === STEPS_HEADING.trim();
      current = null;
      continue;
    }
    if (!inSection) continue;
    const h3 = /^###\s+(.+)$/.exec(line);
    if (h3) {
      current = h3[1].trim();
      if (!map.has(current)) map.set(current, []);
      continue;
    }
    const m = /^-\s*\[([ xX])\]\s*(.+)$/.exec(line);
    if (m && current) {
      map.get(current)!.push({ text: m[2].trim(), done: m[1].toLowerCase() === "x" });
    }
  }
  return map;
}

function parseGoals(content: string): Goal[] {
  const goals: Goal[] = [];
  const stepsMap = parseGoalSteps(content);
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|") || t.includes("---")) continue;
    const cells = t.split("|").map((c) => c.trim());
    if (cells.length < 5) continue;
    const name = cells[1];
    if (!name || name === "目标") continue;
    const targetHours = parseFloat(cells[2]) || 0;
    goals.push({
      name,
      targetHours,
      due: cells[3] || "",
      status: cells[4] || "进行中",
      steps: stepsMap.get(name) || [],
    });
  }
  return goals;
}

function buildGoalsTable(goals: Goal[]): string {
  let s = `| 目标 | 目标时长(h) | 截止日期 | 状态 |\n`;
  s += `| --- | --- | --- | --- |\n`;
  for (const g of goals) {
    s += `| ${g.name} | ${g.targetHours || ""} | ${g.due || ""} | ${g.status} |\n`;
  }
  return s.replace(/\n$/, "");
}

function buildStepsSection(goals: Goal[]): string {
  const list = goals.filter((g) => g.steps.length > 0);
  if (list.length === 0) return "";
  let s = `${STEPS_HEADING}\n\n> 每个目标下用 \`- [ ]\` 列出拆解步骤，勾选后进度会自动统计。\n\n`;
  for (const g of list) {
    s += `### ${g.name}\n`;
    for (const st of g.steps) s += `- [${st.done ? "x" : " "}] ${sanitize(st.text)}\n`;
    s += `\n`;
  }
  return s.trim();
}

/**
 * 写回目标库：只更新表格与「目标拆解」区段，
 * 保留文件里其它手写内容（前言说明、额外章节）。
 */
function writeGoalsFile(content: string, goals: Goal[]): string {
  if (!content.trim()) {
    return `# 目标库\n\n> 由「时间块规划师」插件维护，可手动编辑，目标进度按已完成时间块时长自动统计。\n\n${buildGoalsTable(goals)}\n\n${buildStepsSection(goals)}\n`;
  }

  const lines = content.split("\n");
  const headerIdx = lines.findIndex((l) => l.trim().startsWith("|") && /目标/.test(l) && l.trim().endsWith("|"));

  let preamble: string[];
  let rest: string[];
  if (headerIdx === -1) {
    preamble = lines;
    rest = [];
  } else {
    let end = headerIdx;
    while (end < lines.length && lines[end].trim().startsWith("|")) end++;
    preamble = lines.slice(0, headerIdx);
    rest = lines.slice(end);
  }

  // 剔除旧的「目标拆解」区段，保留其它章节
  const others: string[] = [];
  let skipping = false;
  for (const l of rest) {
    if (/^##\s/.test(l.trim())) skipping = l.trim() === STEPS_HEADING.trim();
    if (!skipping) others.push(l);
  }

  const parts: string[] = [];
  const pre = preamble.join("\n").replace(/\s+$/, "");
  if (pre.trim()) parts.push(pre);
  parts.push(buildGoalsTable(goals));
  const oth = others.join("\n").replace(/^\s+/, "").replace(/\s+$/, "");
  if (oth.trim()) parts.push(oth);
  const steps = buildStepsSection(goals);
  if (steps) parts.push(steps);
  return parts.join("\n\n") + "\n";
}

/* ============================================================
 * 时间块编辑弹窗
 * ============================================================ */

interface BlockModalResult {
  block: Timeblock;
  action: "save" | "delete" | "toggle";
}

class BlockModal extends Modal {
  private block: Timeblock;
  private isNew: boolean;
  private dateLabel: string;
  private goalNames: string[];
  private resolveFn: (r: BlockModalResult | null) => void;

  constructor(app: any, block: Timeblock, isNew: boolean, dateLabel: string, goalNames: string[], resolve: (r: BlockModalResult | null) => void) {
    super(app);
    this.block = { ...block };
    this.isNew = isNew;
    this.dateLabel = dateLabel;
    this.goalNames = goalNames;
    this.resolveFn = resolve;
  }

  onOpen() {
    this.titleEl.setText(`${this.dateLabel} · ${this.isNew ? "新建时间块" : "编辑时间块"}`);
    const { contentEl } = this;
    contentEl.addClass("tbp-modal");

    new Setting(contentEl).setName("标题").addText((t) => {
      t.setValue(this.block.title);
      t.onChange((v) => (this.block.title = sanitize(v) || "未命名"));
    });

    new Setting(contentEl).setName("开始时间").addText((t) => {
      t.inputEl.type = "time";
      t.setValue(fmtTime(this.block.start));
      t.onChange((v) => {
        const p = v.split(":");
        if (p.length === 2) this.block.start = parseInt(p[0]) * 60 + parseInt(p[1]);
      });
    });

    new Setting(contentEl).setName("结束时间").addText((t) => {
      t.inputEl.type = "time";
      t.setValue(fmtTime(this.block.end));
      t.onChange((v) => {
        const p = v.split(":");
        if (p.length === 2) this.block.end = parseInt(p[0]) * 60 + parseInt(p[1]);
      });
    });

    new Setting(contentEl).setName("分类").addDropdown((d) => {
      CATEGORIES.forEach((c) => d.addOption(c, c));
      d.setValue(this.block.category);
      d.onChange((v) => (this.block.category = v));
    });

    const goalSetting = new Setting(contentEl).setName("关联目标");
    if (this.goalNames.length === 0) {
      goalSetting.setDesc("目标库为空，可在左侧目标面板新建目标");
    }
    goalSetting.addDropdown((d) => {
      d.addOption("", "（无）");
      this.goalNames.forEach((g) => d.addOption(g, g));
      d.setValue(this.block.goal);
      d.onChange((v) => (this.block.goal = v));
    });

    new Setting(contentEl).setName("备注").addTextArea((t) => {
      t.setValue(this.block.note);
      t.onChange((v) => (this.block.note = sanitize(v)));
    });

    const btnRow = contentEl.createDiv("tbp-modal-actions");

    if (!this.isNew) {
      const toggleBtn = btnRow.createEl("button", { text: this.block.done ? "标记未完成" : "标记完成" });
      toggleBtn.addEventListener("click", () => {
        this.block.done = !this.block.done;
        const fn = this.resolveFn;
        this.resolveFn = null as any;
        fn({ block: this.block, action: "toggle" });
        this.close();
      });

      const delBtn = btnRow.createEl("button", { text: "删除" });
      delBtn.addClass("mod-warning");
      delBtn.addEventListener("click", () => {
        const fn = this.resolveFn;
        this.resolveFn = null as any;
        fn({ block: this.block, action: "delete" });
        this.close();
      });
    }

    const spacer = btnRow.createDiv("tbp-spacer");
    spacer.style.flex = "1";

    const cancelBtn = btnRow.createEl("button", { text: "取消" });
    cancelBtn.addEventListener("click", () => {
      const fn = this.resolveFn;
      this.resolveFn = null as any;
      fn(null);
      this.close();
    });

    const saveBtn = btnRow.createEl("button", { text: "保存", cls: "mod-cta" });
    saveBtn.addEventListener("click", () => {
      if (this.block.end <= this.block.start) {
        new Notice("结束时间需晚于开始时间");
        return;
      }
      const fn = this.resolveFn;
      this.resolveFn = null as any;
      fn({ block: this.block, action: "save" });
      this.close();
    });
  }

  onClose() {
    this.contentEl.empty();
    if (this.resolveFn) {
      this.resolveFn(null);
      this.resolveFn = null as any;
    }
  }
}

function openBlockModal(
  app: any,
  block: Timeblock,
  isNew: boolean,
  dateLabel: string,
  goalNames: string[]
): Promise<BlockModalResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    const wrapped = (r: BlockModalResult | null) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    new BlockModal(app, block, isNew, dateLabel, goalNames, wrapped).open();
  });
}

/* ============================================================
 * 目标编辑弹窗
 * ============================================================ */

interface GoalModalResult {
  goal: Goal;
  action: "save" | "delete";
}

class GoalModal extends Modal {
  private goal: Goal;
  private isNew: boolean;
  private resolveFn: (r: GoalModalResult | null) => void;

  constructor(app: any, goal: Goal, isNew: boolean, resolve: (r: GoalModalResult | null) => void) {
    super(app);
    this.goal = { ...goal, steps: (goal.steps || []).map((s) => ({ ...s })) };
    this.isNew = isNew;
    this.resolveFn = resolve;
  }

  onOpen() {
    this.titleEl.setText(this.isNew ? "新建目标" : "编辑目标");
    const { contentEl } = this;
    contentEl.addClass("tbp-modal");
    contentEl.addClass("tbp-goal-modal");

    new Setting(contentEl).setName("目标名称").addText((t) => {
      t.setValue(this.goal.name);
      t.onChange((v) => (this.goal.name = sanitize(v)));
    });

    new Setting(contentEl).setName("目标投入时长（小时）").setDesc("用于计算进度百分比，留空表示不追踪").addText((t) => {
      t.inputEl.type = "number";
      t.setValue(String(this.goal.targetHours || ""));
      t.onChange((v) => (this.goal.targetHours = parseFloat(v) || 0));
    });

    new Setting(contentEl).setName("截止日期").addText((t) => {
      t.inputEl.type = "date";
      t.setValue(this.goal.due);
      t.onChange((v) => (this.goal.due = v));
    });

    new Setting(contentEl).setName("状态").addDropdown((d) => {
      GOAL_STATUS.forEach((s) => d.addOption(s, s));
      d.setValue(this.goal.status);
      d.onChange((v) => (this.goal.status = v));
    });

    this.renderStepsEditor(contentEl);

    const btnRow = contentEl.createDiv("tbp-modal-actions");

    if (!this.isNew) {
      const delBtn = btnRow.createEl("button", { text: "删除目标" });
      delBtn.addClass("mod-warning");
      delBtn.addEventListener("click", () => {
        const fn = this.resolveFn;
        this.resolveFn = null as any;
        fn({ goal: this.goal, action: "delete" });
        this.close();
      });
    }

    const spacer = btnRow.createDiv("tbp-spacer");
    spacer.style.flex = "1";

    const cancelBtn = btnRow.createEl("button", { text: "取消" });
    cancelBtn.addEventListener("click", () => {
      const fn = this.resolveFn;
      this.resolveFn = null as any;
      fn(null);
      this.close();
    });

    const saveBtn = btnRow.createEl("button", { text: "保存", cls: "mod-cta" });
    saveBtn.addEventListener("click", () => {
      if (!this.goal.name) {
        new Notice("目标名称不能为空");
        return;
      }
      this.goal.steps = this.goal.steps
        .map((s) => ({ text: sanitize(s.text), done: s.done }))
        .filter((s) => s.text.length > 0);
      const fn = this.resolveFn;
      this.resolveFn = null as any;
      fn({ goal: this.goal, action: "save" });
      this.close();
    });
  }

  /* ---------- 目标拆解编辑器 ---------- */

  private moveStep(i: number, delta: number, redraw: (focusIdx?: number) => void) {
    const j = i + delta;
    if (j < 0 || j >= this.goal.steps.length) return;
    const [s] = this.goal.steps.splice(i, 1);
    this.goal.steps.splice(j, 0, s);
    redraw(j);
  }

  private renderStepsEditor(parent: HTMLElement) {
    const wrap = parent.createDiv("tbp-steps-editor");
    const head = wrap.createDiv("tbp-steps-head");
    head.createDiv("tbp-steps-title").setText("🧩 目标拆解");
    const count = head.createDiv("tbp-steps-count");

    const list = wrap.createDiv("tbp-steps-list");

    const refreshCount = () => {
      const total = this.goal.steps.length;
      const done = this.goal.steps.filter((s) => s.done).length;
      count.setText(total ? `${done}/${total} 步完成` : "未拆解");
      count.toggleClass("is-all-done", total > 0 && done === total);
    };

    const draw = (focusIdx?: number) => {
      list.empty();
      if (this.goal.steps.length === 0) {
        list.createDiv("tbp-steps-empty").setText("把目标拆成能立刻动手的小步骤，行动会变得更轻松。");
      }
      this.goal.steps.forEach((step, i) => {
        const row = list.createDiv("tbp-step-row");
        if (step.done) row.addClass("is-done");

        const cb = row.createEl("input", { type: "checkbox", cls: "tbp-step-check" }) as HTMLInputElement;
        cb.checked = step.done;
        cb.addEventListener("change", () => {
          step.done = cb.checked;
          row.toggleClass("is-done", step.done);
          refreshCount();
        });

        const input = row.createEl("input", { type: "text", cls: "tbp-step-input" }) as HTMLInputElement;
        input.value = step.text;
        input.placeholder = "这一步要做什么";
        input.addEventListener("input", () => {
          step.text = input.value.replace(/[|\r\n]/g, " ");
        });
        input.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter") {
            e.preventDefault();
            this.goal.steps.splice(i + 1, 0, { text: "", done: false });
            draw(i + 1);
            refreshCount();
          } else if (e.key === "Backspace" && input.value === "" && this.goal.steps.length > 0) {
            e.preventDefault();
            this.goal.steps.splice(i, 1);
            draw(Math.max(0, i - 1));
            refreshCount();
          }
        });

        const up = row.createEl("button", { cls: "tbp-step-btn", text: "↑" });
        up.setAttribute("aria-label", "上移");
        up.addEventListener("click", () => this.moveStep(i, -1, draw));

        const down = row.createEl("button", { cls: "tbp-step-btn", text: "↓" });
        down.setAttribute("aria-label", "下移");
        down.addEventListener("click", () => this.moveStep(i, 1, draw));

        const del = row.createEl("button", { cls: "tbp-step-btn tbp-step-del", text: "×" });
        del.setAttribute("aria-label", "删除这一步");
        del.addEventListener("click", () => {
          this.goal.steps.splice(i, 1);
          draw();
          refreshCount();
        });
      });

      if (focusIdx != null) {
        const inputs = list.querySelectorAll(".tbp-step-input");
        const el = inputs[focusIdx] as HTMLInputElement | undefined;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      }
    };

    const addRow = wrap.createDiv("tbp-steps-add");
    const addInput = addRow.createEl("input", {
      type: "text",
      cls: "tbp-step-input",
      attr: { placeholder: "输入一个步骤，回车添加（可粘贴多行批量添加）" },
    }) as HTMLInputElement;
    const addBtn = addRow.createEl("button", { text: "添加", cls: "tbp-today-btn" });

    const addSteps = (raw: string) => {
      const items = raw
        .split(/\r?\n/)
        .map((s) => sanitize(s))
        .filter(Boolean);
      if (items.length === 0) return;
      for (const t of items) this.goal.steps.push({ text: t, done: false });
      addInput.value = "";
      draw();
      refreshCount();
      addInput.focus();
    };

    addBtn.addEventListener("click", () => addSteps(addInput.value));
    addInput.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addSteps(addInput.value);
      }
    });
    addInput.addEventListener("paste", (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text") ?? "";
      if (text.includes("\n")) {
        e.preventDefault();
        addSteps(text);
      }
    });

    draw();
    refreshCount();
  }

  onClose() {
    this.contentEl.empty();
    if (this.resolveFn) {
      this.resolveFn(null);
      this.resolveFn = null as any;
    }
  }
}

function openGoalModal(app: any, goal: Goal, isNew: boolean): Promise<GoalModalResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    const wrapped = (r: GoalModalResult | null) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    new GoalModal(app, goal, isNew, wrapped).open();
  });
}

/* ============================================================
 * 主视图：日视图 / 周视图 + 目标面板
 * ============================================================ */

interface GoalStat {
  doneMin: number; // 累计已完成分钟
  weekMin: number; // 本周已完成分钟
  todayMin: number; // 今日已完成分钟
  todayPlannedMin: number; // 今日计划分钟
}

/** 周视图中的某一列 */
interface WeekColumn {
  date: any; // moment
  laneEl: HTMLElement;
  blocksEl: HTMLElement;
  nowEl: HTMLElement;
}

class TimeblockView extends ItemView {
  plugin: TimeblockPlannerPlugin;
  viewMode: "day" | "week" = "day";
  date: any; // moment：日视图锚点
  weekStart: any; // moment：周视图锚点（周一）
  goals: Goal[] = [];
  goalStats = new Map<string, GoalStat>();
  showGoals = true;
  /** 面板中已展开拆解的目标名 */
  goalStepsOpen = new Set<string>();

  /** 已加载的天数据：key = YYYY-MM-DD */
  dayData = new Map<string, Timeblock[]>();

  private dayLaneEl!: HTMLElement;
  private dayBlocksEl!: HTMLElement;
  private dayNowEl!: HTMLElement;
  private weekCols: WeekColumn[] = [];
  private statsEl!: HTMLElement;
  private goalsPanelEl!: HTMLElement;
  private dateLabelEl!: HTMLElement;
  private modeBtnDay!: HTMLButtonElement;
  private modeBtnWeek!: HTMLButtonElement;
  private reloading = false;
  /** 是否需要把时间轴滚动到当前时刻（仅首次打开 / 点“今天”时） */
  private jumpToNow = false;
  /** 正在进行的手势数（拖拽中禁止重渲染，防止把拖拽中的元素销毁） */
  private interactions = 0;
  private pendingReload = false;

  constructor(leaf: WorkspaceLeaf, plugin: TimeblockPlannerPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.date = moment();
    this.weekStart = moment().startOf("isoWeek");
  }

  getViewType(): string {
    return VIEW_TYPE;
  }
  getDisplayText(): string {
    return "时间块规划";
  }
  getIcon(): string {
    return "calendar-clock";
  }

  async onOpen() {
    this.date = moment();
    this.weekStart = moment().startOf("isoWeek");
    this.jumpToNow = true;
    await this.reloadAll();
    this.registerInterval(
      window.setInterval(() => this.updateNowLine(), 30 * 1000)
    );
  }

  async reloadAll() {
    // 拖拽进行中不允许重渲染（否则拖拽中的元素会被销毁），挂起等待手势结束
    if (this.interactions > 0) {
      this.pendingReload = true;
      return;
    }
    if (this.reloading) return;
    this.reloading = true;
    try {
      await this.loadVisibleDays();
      await this.loadGoals();
      this.render();
      this.computeGoalStats();
    } finally {
      this.reloading = false;
    }
  }

  /** 手势开始/结束（结束时若有挂起的外部刷新则补执行） */
  private startInteraction() {
    this.interactions++;
  }

  private endInteraction() {
    this.interactions = Math.max(0, this.interactions - 1);
    if (this.interactions === 0 && this.pendingReload) {
      this.pendingReload = false;
      this.reloadAll();
    }
  }

  async onClose() {
    // 定时器由 registerInterval 管理
  }

  /* ---------- 数据读写 ---------- */

  private keyOf(m: any): string {
    return m.format("YYYY-MM-DD");
  }

  private pathOf(date: any): string {
    return `${this.plugin.settings.scheduleFolder}/${this.keyOf(date)}.md`;
  }

  private async loadVisibleDays() {
    if (this.viewMode === "day") {
      await this.loadDayInto(this.date);
    } else {
      for (let i = 0; i < 7; i++) {
        await this.loadDayInto(this.weekStart.clone().add(i, "day"));
      }
    }
  }

  private async loadDayInto(date: any) {
    const path = this.pathOf(date);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      const content = await this.app.vault.read(file);
      this.dayData.set(this.keyOf(date), parseDayBlocks(content));
    } else {
      this.dayData.set(this.keyOf(date), []);
    }
  }

  private blocksOf(date: any): Timeblock[] {
    return this.dayData.get(this.keyOf(date)) || [];
  }

  private async ensureFolders(path: string) {
    const parts = path.split("/");
    parts.pop();
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try {
          await this.app.vault.createFolder(cur);
        } catch (e) {
          // 并发创建或已存在时忽略
        }
      }
    }
  }

  private async persistDayOf(date: any) {
    const path = this.pathOf(date);
    await this.ensureFolders(path);
    const blocks = this.blocksOf(date);
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      const content = dayTemplate(this.keyOf(date), blocks);
      this.plugin.markSelfWrite(path);
      await this.app.vault.create(path, content);
      return;
    }
    this.plugin.markSelfWrite(path);
    await this.app.vault.process(file, (content) => writeDayBlocks(content, blocks));
  }

  private async loadGoals() {
    const path = this.plugin.settings.goalsFile;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      const content = await this.app.vault.read(file);
      this.goals = parseGoals(content);
    } else {
      this.goals = [];
    }
  }

  private async persistGoals() {
    const path = this.plugin.settings.goalsFile;
    await this.ensureFolders(path);
    const file = this.app.vault.getAbstractFileByPath(path);
    this.plugin.markSelfWrite(path);
    if (file instanceof TFile) {
      await this.app.vault.process(file, (content) => writeGoalsFile(content, this.goals));
    } else {
      await this.app.vault.create(path, writeGoalsFile("", this.goals));
    }
  }

  /* ---------- 渲染总入口 ---------- */

  private render() {
    // 记住重渲染前的滚动位置，避免每次编辑后视图跳走
    const oldWrap = this.contentEl.querySelector(".tbp-timeline-wrap") as HTMLElement | null;
    const savedScroll = oldWrap ? oldWrap.scrollTop : null;
    const root = this.contentEl;
    root.empty();
    root.addClass("tbp-root");

    // ---- 顶部栏 ----
    const header = root.createDiv("tbp-header");

    const nav = header.createDiv("tbp-nav");
    const prevBtn = nav.createEl("button", { cls: "tbp-icon-btn" });
    prevBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>';
    prevBtn.addEventListener("click", () => (this.viewMode === "day" ? this.changeDay(-1) : this.changeWeek(-1)));
    this.dateLabelEl = nav.createDiv("tbp-date-label");
    const nextBtn = nav.createEl("button", { cls: "tbp-icon-btn" });
    nextBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>';
    nextBtn.addEventListener("click", () => (this.viewMode === "day" ? this.changeDay(1) : this.changeWeek(1)));
    const todayBtn = nav.createEl("button", { text: "今天", cls: "tbp-today-btn" });
    todayBtn.addEventListener("click", () => {
      this.date = moment();
      this.weekStart = moment().startOf("isoWeek");
      this.jumpToNow = true;
      this.reloadAll();
    });

    // 日 / 周 模式切换
    const modeToggle = nav.createDiv("tbp-mode-toggle");
    this.modeBtnDay = modeToggle.createEl("button", { text: "日", cls: "tbp-mode-btn" });
    this.modeBtnWeek = modeToggle.createEl("button", { text: "周", cls: "tbp-mode-btn" });
    this.modeBtnDay.addEventListener("click", () => this.switchMode("day"));
    this.modeBtnWeek.addEventListener("click", () => this.switchMode("week"));

    this.statsEl = header.createDiv("tbp-stats");

    const actions = header.createDiv("tbp-actions");
    const newBlockBtn = actions.createEl("button", { text: "＋ 时间块", cls: "tbp-primary-btn" });
    newBlockBtn.addEventListener("click", () => this.openNewBlockModal(this.anchorDate()));
    const goalsToggle = actions.createEl("button", { text: "目标", cls: "tbp-today-btn" });
    goalsToggle.addEventListener("click", () => {
      this.showGoals = !this.showGoals;
      this.goalsPanelEl.classList.toggle("tbp-hidden", !this.showGoals);
    });

    this.updateModeButtons();
    this.updateDateLabel();
    this.updateStats();

    // ---- 主体 ----
    const body = root.createDiv("tbp-body");

    this.goalsPanelEl = body.createDiv("tbp-goals");
    this.renderGoalsPanel();

    if (this.viewMode === "day") {
      this.renderDayTimeline(body);
    } else {
      this.renderWeekTimeline(body);
    }

    // 恢复滚动位置；只有首次打开 / 点“今天”时才定位到当前时刻
    const wrap = this.contentEl.querySelector(".tbp-timeline-wrap") as HTMLElement | null;
    if (this.jumpToNow) {
      this.jumpToNow = false;
      this.scrollToNow();
    } else if (wrap && savedScroll != null && savedScroll > 0) {
      wrap.scrollTop = savedScroll;
    }
  }

  /** 当前视图的“锚点”日期：日视图=当天，周视图=今天（若在本周内），否则=周一 */
  private anchorDate(): any {
    if (this.viewMode === "day") return this.date;
    const today = moment();
    for (let i = 0; i < 7; i++) {
      const d = this.weekStart.clone().add(i, "day");
      if (d.isSame(today, "day")) return d;
    }
    return this.weekStart;
  }

  private async switchMode(mode: "day" | "week") {
    if (this.viewMode === mode) return;
    this.viewMode = mode;
    await this.loadVisibleDays();
    this.render();
    this.computeGoalStats();
  }

  private updateModeButtons() {
    this.modeBtnDay.classList.toggle("active", this.viewMode === "day");
    this.modeBtnWeek.classList.toggle("active", this.viewMode === "week");
  }

  private updateDateLabel() {
    if (this.viewMode === "day") {
      const isToday = this.date.isSame(moment(), "day");
      this.dateLabelEl.setText(`${this.date.format("YYYY年MM月DD日 dddd")}${isToday ? " · 今天" : ""}`);
    } else {
      const end = this.weekStart.clone().add(6, "day");
      const isThisWeek = this.weekStart.isSame(moment().startOf("isoWeek"));
      const weekNum = this.weekStart.isoWeek();
      this.dateLabelEl.setText(
        `${this.weekStart.format("MM月DD日")} – ${end.format("MM月DD日")} · 第${weekNum}周${isThisWeek ? " · 本周" : ""}`
      );
    }
  }

  /* ---------- 时间轴骨架 ---------- */

  private buildHoursCol(parent: HTMLElement, headerSpacer = false): HTMLElement {
    const { startHour, endHour, pxPerHour } = this.plugin.settings;
    const hours = parent.createDiv("tbp-hours");
    // 周视图：日列顶部有吸顶表头（占 36px 布局高度），刻度列要留同样的空位，保证刻度与时间轴对齐
    if (headerSpacer) {
      hours.createDiv("tbp-head-spacer");
    }
    for (let h = startHour; h < endHour; h++) {
      const label = hours.createDiv("tbp-hour-label");
      label.style.height = `${pxPerHour}px`;
      label.setText(`${String(h).padStart(2, "0")}:00`);
    }
    return hours;
  }

  private buildLane(parent: HTMLElement): HTMLElement {
    const { startHour, endHour, pxPerHour } = this.plugin.settings;
    const lane = parent.createDiv("tbp-lane");
    // 显式指定整天高度，避免 flex 拉伸导致时间轴被压缩、末端槽位丢失
    lane.style.height = `${(endHour - startHour) * pxPerHour}px`;
    const px = pxPerHour;
    const half = px / 2;
    lane.style.background = `repeating-linear-gradient(to bottom, transparent 0, transparent ${px - 1}px, var(--background-modifier-border) ${px - 1}px, var(--background-modifier-border) ${px}px), repeating-linear-gradient(to bottom, transparent 0, transparent ${half - 1}px, color-mix(in srgb, var(--background-modifier-border) 50%, transparent) ${half - 1}px, color-mix(in srgb, var(--background-modifier-border) 50%, transparent) ${half}px)`;
    return lane;
  }

  private renderDayTimeline(body: HTMLElement) {
    const wrap = body.createDiv("tbp-timeline-wrap");
    this.buildHoursCol(wrap);

    this.dayLaneEl = this.buildLane(wrap);
    this.dayBlocksEl = this.dayLaneEl.createDiv("tbp-blocks");
    this.dayNowEl = this.dayLaneEl.createDiv("tbp-now");
    // 用 getter 实时取当前日期：时间轴骨架只在整渲染时重建一次，
    // 而 changeDay 只重绘时间块；若在此处固定捕获日期，切换日期后圈选仍会写入旧日期
    this.bindLaneCreateEvents(this.dayLaneEl, () => this.date);

    this.renderBlocks();
    this.updateNowLine();
  }

  private renderWeekTimeline(body: HTMLElement) {
    const wrap = body.createDiv("tbp-timeline-wrap");
    const week = wrap.createDiv("tbp-week");
    this.buildHoursCol(week, true);

    this.weekCols = [];
    const today = moment();

    for (let i = 0; i < 7; i++) {
      const date = this.weekStart.clone().add(i, "day");
      const col = week.createDiv("tbp-day-col");

      const head = col.createDiv("tbp-day-head");
      if (date.isSame(today, "day")) head.addClass("is-today");
      const dow = date.isoWeekday(); // 1=周一 … 7=周日
      if (dow >= 6) head.addClass("is-weekend");
      head.createDiv("tbp-day-dow").setText(date.format("ddd")); // 周一
      head.createDiv("tbp-day-date").setText(date.format("MM/DD"));
      head.addEventListener("click", () => {
        this.date = date.clone();
        this.switchMode("day");
      });

      const lane = this.buildLane(col);
      lane.addClass("tbp-week-lane");
      const blocksEl = lane.createDiv("tbp-blocks");
      const nowEl = lane.createDiv("tbp-now");

      this.bindLaneCreateEvents(lane, () => date);

      this.weekCols.push({ date, laneEl: lane, blocksEl, nowEl });
    }

    this.renderBlocks();
    this.updateNowLine();
  }

  private scrollToNow() {
    const wrap = this.contentEl.querySelector(".tbp-timeline-wrap") as HTMLElement | null;
    if (!wrap) return;
    const { startHour } = this.plugin.settings;
    const nowMin = moment().hours() * 60 + moment().minutes();
    if (nowMin > startHour * 60) {
      wrap.scrollTop = Math.max(0, ((nowMin - startHour * 60) / 60) * this.plugin.settings.pxPerHour - 120);
    }
  }

  private updateStats() {
    if (this.viewMode === "day") {
      const blocks = this.blocksOf(this.date);
      const total = blocks.length;
      const done = blocks.filter((b) => b.done).length;
      const plannedMin = blocks.reduce((s, b) => s + (b.end - b.start), 0);
      const doneMin = blocks.filter((b) => b.done).reduce((s, b) => s + (b.end - b.start), 0);
      this.statsEl.empty();
      this.statsEl.createSpan({ text: `块 ${total}` }).addClass("tbp-chip");
      this.statsEl.createSpan({ text: `完成 ${done}/${total}` }).addClass("tbp-chip");
      this.statsEl.createSpan({ text: `已排 ${fmtDuration(plannedMin)}` }).addClass("tbp-chip");
      this.statsEl.createSpan({ text: `已完成 ${fmtDuration(doneMin)}` }).addClass("tbp-chip");
    } else {
      let total = 0;
      let done = 0;
      let plannedMin = 0;
      let doneMin = 0;
      for (let i = 0; i < 7; i++) {
        const blocks = this.blocksOf(this.weekStart.clone().add(i, "day"));
        total += blocks.length;
        done += blocks.filter((b) => b.done).length;
        plannedMin += blocks.reduce((s, b) => s + (b.end - b.start), 0);
        doneMin += blocks.filter((b) => b.done).reduce((s, b) => s + (b.end - b.start), 0);
      }
      this.statsEl.empty();
      this.statsEl.createSpan({ text: `块 ${total}` }).addClass("tbp-chip");
      this.statsEl.createSpan({ text: `完成 ${done}/${total}` }).addClass("tbp-chip");
      this.statsEl.createSpan({ text: `已排 ${fmtDuration(plannedMin)}` }).addClass("tbp-chip");
      this.statsEl.createSpan({ text: `已完成 ${fmtDuration(doneMin)}` }).addClass("tbp-chip");
    }
  }

  private updateNowLine() {
    const now = moment();
    if (this.viewMode === "day") {
      if (!this.dayNowEl || !this.date.isSame(now, "day")) {
        if (this.dayNowEl) this.dayNowEl.style.display = "none";
        return;
      }
      const min = now.hours() * 60 + now.minutes();
      this.applyNowLine(this.dayNowEl, min);
    } else {
      for (const col of this.weekCols) {
        if (!col.nowEl) continue;
        if (!col.date.isSame(now, "day")) {
          col.nowEl.style.display = "none";
          continue;
        }
        const min = now.hours() * 60 + now.minutes();
        this.applyNowLine(col.nowEl, min);
      }
    }
  }

  private applyNowLine(el: HTMLElement, min: number) {
    const { startHour, endHour } = this.plugin.settings;
    if (min < startHour * 60 || min > endHour * 60) {
      el.style.display = "none";
      return;
    }
    el.style.display = "block";
    el.style.top = `${this.minToY(min)}px`;
  }

  /* ---------- 目标面板 ---------- */

  private renderGoalsPanel() {
    const panel = this.goalsPanelEl;
    if (!panel) return;
    const savedScroll = panel.scrollTop;
    panel.empty();
    panel.classList.toggle("tbp-hidden", !this.showGoals);

    const title = panel.createDiv("tbp-goals-title");
    title.setText("🎯 目标库");
    const newGoalBtn = title.createEl("button", { text: "＋ 新建" });
    newGoalBtn.addEventListener("click", () => this.openNewGoalModal());

    if (this.goals.length === 0) {
      panel.createDiv("tbp-goals-empty").setText("还没有目标。新建一个，然后把时间块关联到它，投入时长会自动累计。");
      panel.scrollTop = savedScroll;
      return;
    }

    for (const g of this.goals) {
      const stat = this.goalStats.get(g.name) || { doneMin: 0, weekMin: 0, todayMin: 0, todayPlannedMin: 0 };
      const card = panel.createDiv("tbp-goal-card");
      if (g.status === "已完成") card.addClass("tbp-goal-done");
      if (g.status === "暂停") card.addClass("tbp-goal-paused");

      const head = card.createDiv("tbp-goal-head");
      head.createDiv("tbp-goal-name").setText(g.name);
      if (g.due) {
        const dueEl = head.createDiv("tbp-goal-due");
        dueEl.setText(`⏳ ${g.due}`);
        const days = moment(g.due, "YYYY-MM-DD").diff(moment(), "days");
        if (days >= 0 && days <= 7 && g.status === "进行中") dueEl.addClass("tbp-due-soon");
      }

      if (g.targetHours > 0) {
        const pct = Math.min(100, Math.round((stat.doneMin / 60 / g.targetHours) * 100));
        const bar = card.createDiv("tbp-progress");
        const fill = bar.createDiv("tbp-progress-fill");
        fill.style.width = `${pct}%`;
        const meta = card.createDiv("tbp-goal-meta");
        meta.setText(`已投入 ${fmtDuration(stat.doneMin)} / ${g.targetHours}h（${pct}%）· 本周 ${fmtDuration(stat.weekMin)} · 今日 ${fmtDuration(stat.todayMin)}`);
      } else {
        const meta = card.createDiv("tbp-goal-meta");
        meta.setText(`已投入 ${fmtDuration(stat.doneMin)} · 本周 ${fmtDuration(stat.weekMin)} · 今日 ${fmtDuration(stat.todayMin)}`);
      }

      if (g.status !== "进行中") {
        card.createDiv("tbp-goal-status").setText(g.status);
      }

      if (g.steps.length > 0) this.renderGoalStepsCard(card, g);

      const btns = card.createDiv("tbp-goal-btns");
      const planBtn = btns.createEl("button", { text: "安排时间", cls: "tbp-today-btn" });
      planBtn.addEventListener("click", () => this.openNewBlockModal(this.anchorDate(), g.name));
      const editBtn = btns.createEl("button", { text: "编辑", cls: "tbp-today-btn" });
      editBtn.addEventListener("click", () => this.openEditGoalModal(g));

      if (stat.todayPlannedMin > 0 && stat.todayMin < stat.todayPlannedMin) {
        card.createDiv("tbp-goal-plan-hint").setText(`今日计划 ${fmtDuration(stat.todayPlannedMin)}，已完成 ${fmtDuration(stat.todayMin)}`);
      }
    }

    panel.scrollTop = savedScroll;
  }

  /* ---------- 目标拆解（面板展示） ---------- */

  private renderGoalStepsCard(card: HTMLElement, g: Goal) {
    const total = g.steps.length;
    const done = g.steps.filter((s) => s.done).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const open = this.goalStepsOpen.has(g.name);
    const next = g.steps.find((s) => !s.done);

    const box = card.createDiv("tbp-goal-steps");
    const head = box.createDiv("tbp-goal-steps-head");

    const label = head.createDiv("tbp-goal-steps-label");
    label.setText(`🧩 ${done}/${total} 步`);

    const bar = head.createDiv("tbp-mini-bar");
    const fill = bar.createDiv("tbp-mini-fill");
    fill.style.width = `${pct}%`;
    if (done === total) bar.addClass("is-all-done");

    const toggle = head.createEl("button", { cls: "tbp-steps-toggle", text: open ? "收起" : "展开" });
    toggle.addEventListener("click", () => {
      if (open) this.goalStepsOpen.delete(g.name);
      else this.goalStepsOpen.add(g.name);
      this.renderGoalsPanel();
    });

    if (!open) {
      if (next) {
        const nx = box.createDiv("tbp-goal-step-next");
        nx.setText(`下一步 · ${next.text}`);
      } else {
        box.createDiv("tbp-goal-step-next is-done").setText("全部步骤已完成 🎉");
      }
      return;
    }

    const list = box.createDiv("tbp-goal-steps-list");
    g.steps.forEach((s, i) => {
      const row = list.createDiv("tbp-goal-step");
      if (s.done) row.addClass("is-done");

      const cb = row.createEl("input", { type: "checkbox", cls: "tbp-step-check" }) as HTMLInputElement;
      cb.checked = s.done;
      cb.addEventListener("change", () => this.toggleGoalStep(g, i));

      const txt = row.createDiv("tbp-goal-step-text");
      txt.setText(s.text);
      txt.addEventListener("click", () => this.toggleGoalStep(g, i));

      const plan = row.createEl("button", { cls: "tbp-step-plan", text: "＋" });
      plan.setAttribute("aria-label", "为这一步安排时间块");
      plan.addEventListener("click", (e) => {
        e.stopPropagation();
        this.openNewBlockModal(this.anchorDate(), g.name, undefined, undefined, s.text);
      });
    });
  }

  private async toggleGoalStep(g: Goal, i: number) {
    const step = g.steps[i];
    if (!step) return;
    step.done = !step.done;
    await this.persistGoals();
    this.renderGoalsPanel();
  }

  /* ---------- 时间块渲染 ---------- */

  private renderBlocks() {
    if (this.viewMode === "day") {
      this.dayBlocksEl.empty();
      this.blocksOf(this.date).forEach((b, idx) => {
        this.dayBlocksEl.appendChild(this.createBlockEl(b, this.date, idx, false));
      });
    } else {
      for (const col of this.weekCols) {
        col.blocksEl.empty();
        this.blocksOf(col.date).forEach((b, idx) => {
          col.blocksEl.appendChild(this.createBlockEl(b, col.date, idx, true));
        });
      }
    }
    this.updateStats();
    this.updateNowLine();
  }

  private createBlockEl(b: Timeblock, date: any, idx: number, compact: boolean): HTMLElement {
    const { startHour, endHour } = this.plugin.settings;
    const el = document.createElement("div");
    el.addClass("tbp-block");
    if (compact) el.addClass("tbp-compact");
    el.addClass(CAT_CLASS[b.category] || "tbp-cat-misc");
    if (b.done) el.addClass("tbp-done");
    el.dataset.index = String(idx);
    el.dataset.date = this.keyOf(date);

    const top = this.minToY(Math.max(b.start, startHour * 60));
    const bottom = this.minToY(Math.min(b.end, endHour * 60));
    const h = Math.max(bottom - top, compact ? 16 : 20);
    el.style.top = `${top}px`;
    el.style.height = `${h}px`;
    if (compact && h >= 44) el.addClass("tbp-tall");

    const check = el.createDiv("tbp-check");
    check.addEventListener("pointerdown", (e) => e.stopPropagation());
    check.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleBlock(date, idx);
    });

    el.createDiv("tbp-block-title").setText(b.title);
    el.createDiv("tbp-block-time").setText(compact ? fmtTime(b.start) : `${fmtTime(b.start)} – ${fmtTime(b.end)}`);
    if (b.goal) el.createDiv("tbp-goal-chip").setText(`🎯 ${b.goal}`);
    if (b.note && !compact) el.createDiv("tbp-block-note").setText(b.note);

    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.showBlockMenu(e, date, idx);
    });

    if (!compact) {
      const resize = el.createDiv("tbp-resize");
      resize.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        this.beginResize(e, el, date, idx);
      });
      resize.addEventListener("click", (e) => e.stopPropagation());
    }

    // 日视图与周视图统一：拖拽移动时间块，松手未移动视为点击 → 编辑
    el.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).classList.contains("tbp-check")) return;
      if ((e.target as HTMLElement).classList.contains("tbp-resize")) return;
      e.stopPropagation();
      this.beginBlockDrag(e, el, date, idx);
    });

    return el;
  }

  private showBlockMenu(e: MouseEvent, date: any, idx: number) {
    const menu = new Menu();
    const b = this.blocksOf(date)[idx];
    if (!b) return;
    menu.addItem((item) =>
      item.setTitle(b.done ? "标记未完成" : "标记完成").setIcon("check").onClick(() => this.toggleBlock(date, idx))
    );
    menu.addItem((item) =>
      item.setTitle("编辑").setIcon("pencil").onClick(() => this.openEditBlockModal(date, idx))
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle("删除").setIcon("trash-2").onClick(() => this.deleteBlock(date, idx))
    );
    menu.showAtMouseEvent(e);
  }

  /* ---------- 坐标换算 ---------- */

  private get pxPerMin(): number {
    return this.plugin.settings.pxPerHour / 60;
  }

  private minToY(min: number): number {
    return (min - this.plugin.settings.startHour * 60) * this.pxPerMin;
  }

  private yToMin(lane: HTMLElement, y: number, snap = true): number {
    const rect = lane.getBoundingClientRect();
    let min = (y - rect.top) / this.pxPerMin + this.plugin.settings.startHour * 60;
    if (snap) min = Math.round(min / 30) * 30;
    const lo = this.plugin.settings.startHour * 60;
    const hi = this.plugin.settings.endHour * 60;
    return Math.min(Math.max(min, lo), hi);
  }

  /* ---------- 拖拽交互 ---------- */

  /** 拖拽到滚动容器上/下边缘时自动滚动，保证能把块拖到可视区之外的时间段 */
  private autoScrollDuringDrag(ev: PointerEvent) {
    const wrap = this.contentEl.querySelector(".tbp-timeline-wrap") as HTMLElement | null;
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    const margin = 40;
    if (ev.clientY < r.top + margin) {
      wrap.scrollTop -= Math.min(14, (r.top + margin - ev.clientY) / 3);
    } else if (ev.clientY > r.bottom - margin) {
      wrap.scrollTop += Math.min(14, (ev.clientY - (r.bottom - margin)) / 3);
    }
  }

  /** 空白处拖拽圈选创建时间块（日/周视图通用）。getDate 实时返回该 lane 对应的日期。 */
  private bindLaneCreateEvents(lane: HTMLElement, getDate: () => any) {
    lane.addEventListener("pointerdown", (e) => {
      const t = e.target as HTMLElement;
      if (t !== lane && t !== lane.querySelector(":scope > .tbp-blocks")) {
        // 允许 blocks 容器本身（空白区域）
        const blocksEl = lane.querySelector(":scope > .tbp-blocks");
        if (t !== blocksEl) return;
      }
      this.beginCreateDrag(e, lane, getDate());
    });
  }

  private beginCreateDrag(e: PointerEvent, lane: HTMLElement, date: any) {
    e.preventDefault();
    lane.setPointerCapture(e.pointerId);
    // 锚点 = 按下位置；拖动可以向上或向下，最终取 [min, max]
    const anchorMin = this.yToMin(lane, e.clientY);
    let endMin = anchorMin;

    const preview = document.createElement("div");
    preview.addClass("tbp-preview");
    preview.setText("");
    lane.appendChild(preview);
    const draw = (s: number, en: number) => {
      const lo = Math.min(s, en);
      const hi = Math.max(s, en);
      preview.style.display = "block";
      preview.style.top = `${this.minToY(lo)}px`;
      preview.style.height = `${Math.max(this.minToY(hi) - this.minToY(lo), 12)}px`;
      preview.setText(`${fmtTime(lo)} – ${fmtTime(hi)}`);
    };
    draw(anchorMin, endMin);

    this.startInteraction();

    const cleanup = () => {
      lane.removeEventListener("pointermove", onMove);
      lane.removeEventListener("pointerup", onUp);
      lane.removeEventListener("pointercancel", onCancel);
    };
    const onMove = (ev: PointerEvent) => {
      this.autoScrollDuringDrag(ev);
      endMin = this.yToMin(lane, ev.clientY);
      draw(anchorMin, endMin);
    };
    const onUp = () => {
      cleanup();
      preview.remove();
      const hi = this.plugin.settings.endHour * 60;
      let s = Math.min(anchorMin, endMin);
      let en = Math.max(anchorMin, endMin);
      if (en <= s) {
        // 点击未拖动：默认 1 小时；若按在最末端（如 23:45 后四舍五入到 24:00），往前退一小时
        if (s >= hi) s = hi - 60;
        en = Math.min(s + 60, hi);
      }
      this.endInteraction();
      this.openNewBlockModal(date, "", s, en);
    };
    const onCancel = () => {
      cleanup();
      preview.remove();
      this.endInteraction();
    };
    lane.addEventListener("pointermove", onMove);
    lane.addEventListener("pointerup", onUp);
    lane.addEventListener("pointercancel", onCancel);
  }

  /** 拖动时间块整体移动（日/周视图通用）。
   *  用“当前指针位置反推目标时间”而非累计位移增量，滚动/缩放过程中都不会失真。 */
  private beginBlockDrag(e: PointerEvent, el: HTMLElement, date: any, idx: number) {
    e.preventDefault();
    const b = this.blocksOf(date)[idx];
    if (!b) return;
    const lane = (el.closest(".tbp-lane") as HTMLElement) || this.dayLaneEl;
    const dur = b.end - b.start;
    // 按下时指针相对块起点的偏移（分钟）
    const grabOffset = this.yToMin(lane, e.clientY, false) - b.start;
    let moved = false;
    let newStart: number | null = null;

    this.startInteraction();
    el.setPointerCapture(e.pointerId);

    const cleanup = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
      el.classList.remove("tbp-dragging");
    };
    const onMove = (ev: PointerEvent) => {
      this.autoScrollDuringDrag(ev);
      const pointerMin = this.yToMin(lane, ev.clientY, false);
      const target = Math.round((pointerMin - grabOffset) / 30) * 30;
      if (!moved) {
        if (Math.abs(target - b.start) * this.pxPerMin < 6) return;
        moved = true;
        el.addClass("tbp-dragging");
      }
      const lo = this.plugin.settings.startHour * 60;
      const hi = this.plugin.settings.endHour * 60;
      const ns = Math.min(Math.max(target, lo), hi - dur);
      newStart = ns;
      el.style.top = `${this.minToY(ns)}px`;
      el.style.height = `${Math.max(dur * this.pxPerMin, 16)}px`;
    };
    const onUp = () => {
      cleanup();
      this.endInteraction();
      if (moved && newStart != null && newStart !== b.start) {
        b.start = newStart;
        b.end = b.start + dur;
        this.afterBlocksChanged(date);
      } else {
        // 视为点击：打开编辑弹窗
        this.openEditBlockModal(date, idx);
      }
    };
    const onCancel = () => {
      cleanup();
      this.endInteraction();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
  }

  private beginResize(e: PointerEvent, el: HTMLElement, date: any, idx: number) {
    e.preventDefault();
    const b = this.blocksOf(date)[idx];
    if (!b) return;
    const lane = (el.closest(".tbp-lane") as HTMLElement) || this.dayLaneEl;
    let newEnd: number | null = null;

    this.startInteraction();
    el.setPointerCapture(e.pointerId);

    const cleanup = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
    };
    const onMove = (ev: PointerEvent) => {
      this.autoScrollDuringDrag(ev);
      let ne = this.yToMin(lane, ev.clientY);
      ne = Math.max(ne, b.start + 30);
      newEnd = ne;
      el.style.height = `${Math.max(this.minToY(ne) - this.minToY(b.start), 20)}px`;
    };
    const onUp = () => {
      cleanup();
      this.endInteraction();
      if (newEnd != null && newEnd !== b.end) {
        b.end = newEnd;
        this.afterBlocksChanged(date);
      }
    };
    const onCancel = () => {
      cleanup();
      this.endInteraction();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
  }

  /* ---------- 块操作 ---------- */

  private async afterBlocksChanged(date: any) {
    await this.persistDayOf(date);
    this.renderBlocks();
    this.renderGoalsPanel();
    this.computeGoalStats();
  }

  private async toggleBlock(date: any, idx: number) {
    const b = this.blocksOf(date)[idx];
    if (!b) return;
    b.done = !b.done;
    await this.afterBlocksChanged(date);
    new Notice(b.done ? "已完成 ✓" : "已标记未完成");
  }

  private async deleteBlock(date: any, idx: number) {
    const blocks = this.blocksOf(date);
    blocks.splice(idx, 1);
    await this.afterBlocksChanged(date);
  }

  async openNewBlockModal(date: any, goalName = "", startMin?: number, endMin?: number, title = "") {
    const now = moment();
    let s = startMin;
    if (s == null) {
      if (date.isSame(now, "day")) {
        s = Math.ceil((now.hours() * 60 + now.minutes()) / 30) * 30;
      } else {
        s = this.plugin.settings.startHour * 60 + 60;
      }
    }
    let en = endMin;
    if (en == null) en = Math.min(s + 60, this.plugin.settings.endHour * 60);
    const block: Timeblock = {
      start: s,
      end: en,
      title: title || "",
      category: "专注",
      goal: goalName || "",
      note: "",
      done: false,
    };
    const dateLabel = `${date.format("MM月DD日 ddd")}`;
    const r = await openBlockModal(this.app, block, true, dateLabel, this.goals.map((g) => g.name));
    if (!r || r.action !== "save") return;
    if (!r.block.goal && goalName) r.block.goal = goalName;
    if (!this.dayData.has(this.keyOf(date))) {
      await this.loadDayInto(date);
    }
    this.blocksOf(date).push(r.block);
    // 若被编辑的是当前不可见日期（周视图之外的调用），仅保存
    await this.afterBlocksChanged(date);
  }

  private async openEditBlockModal(date: any, idx: number) {
    const b = this.blocksOf(date)[idx];
    if (!b) return;
    const dateLabel = `${date.format("MM月DD日 ddd")}`;
    const r = await openBlockModal(this.app, b, false, dateLabel, this.goals.map((g) => g.name));
    if (!r) return;
    if (r.action === "delete") {
      this.deleteBlock(date, idx);
      return;
    }
    if (r.action === "toggle") {
      this.toggleBlock(date, idx);
      return;
    }
    const blocks = this.blocksOf(date);
    if (blocks[idx]) blocks[idx] = r.block;
    await this.afterBlocksChanged(date);
  }

  /* ---------- 目标操作 ---------- */

  async openNewGoalModal() {
    const goal: Goal = { name: "", targetHours: 0, due: "", status: "进行中", steps: [] };
    const r = await openGoalModal(this.app, goal, true);
    if (!r || r.action !== "save") return;
    if (this.goals.some((g) => g.name === r.goal.name)) {
      new Notice("已存在同名目标");
      return;
    }
    this.goals.push(r.goal);
    await this.persistGoals();
    this.renderGoalsPanel();
    this.computeGoalStats();
  }

  private async openEditGoalModal(goal: Goal) {
    const idx = this.goals.indexOf(goal);
    const r = await openGoalModal(this.app, goal, false);
    if (!r) return;
    if (r.action === "delete") {
      this.goals.splice(idx, 1);
      await this.persistGoals();
      this.renderGoalsPanel();
      this.computeGoalStats();
      return;
    }
    // 重命名时同步更新已加载时间块中的目标名
    if (r.goal.name !== goal.name) {
      for (const [key, blocks] of Array.from(this.dayData.entries())) {
        let changed = false;
        for (const b of blocks) {
          if (b.goal === goal.name) {
            b.goal = r.goal.name;
            changed = true;
          }
        }
        if (changed) await this.persistDayOf(moment(key, "YYYY-MM-DD"));
      }
      this.renderBlocks();
    }
    this.goals[idx] = r.goal;
    await this.persistGoals();
    this.renderGoalsPanel();
    this.computeGoalStats();
  }

  /* ---------- 日期 / 周切换 ---------- */

  private async changeDay(delta: number) {
    this.date = this.date.clone().add(delta, "day");
    await this.loadDayInto(this.date);
    this.updateDateLabel();
    this.renderBlocks();
    this.renderGoalsPanel();
    this.computeGoalStats();
  }

  private async changeWeek(delta: number) {
    this.weekStart = this.weekStart.clone().add(delta, "week");
    await this.loadVisibleDays();
    this.updateDateLabel();
    this.render();
    this.computeGoalStats();
  }

  /* ---------- 目标统计（扫描日程文件夹） ---------- */

  private async computeGoalStats() {
    const folder = this.plugin.settings.scheduleFolder;
    const stats = new Map<string, GoalStat>();
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.parent && f.parent.path === folder);
    const weekStart = moment().startOf("isoWeek");
    const today = moment();

    const dayStat = (name: string): GoalStat => {
      let s = stats.get(name);
      if (!s) {
        s = { doneMin: 0, weekMin: 0, todayMin: 0, todayPlannedMin: 0 };
        stats.set(name, s);
      }
      return s;
    };

    const updateFile = async (f: TFile) => {
      const m = moment(f.basename, "YYYY-MM-DD", true);
      if (!m.isValid()) return;
      const content = await this.app.vault.cachedRead(f);
      const blocks = parseDayBlocks(content);
      for (const b of blocks) {
        if (!b.goal) continue;
        const s = dayStat(b.goal);
        if (m.isSame(today, "day")) {
          s.todayPlannedMin += b.end - b.start;
          if (b.done) s.todayMin += b.end - b.start;
        }
        if (m.isSameOrAfter(weekStart)) {
          if (b.done) s.weekMin += b.end - b.start;
        }
        if (b.done) s.doneMin += b.end - b.start;
      }
    };

    await Promise.all(files.map(updateFile));
    this.goalStats = stats;
    this.renderGoalsPanel();
  }
}

/* ============================================================
 * 插件主体
 * ============================================================ */

export default class TimeblockPlannerPlugin extends Plugin {
  settings: TimeblockSettings;

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new TimeblockView(leaf, this));

    this.addRibbonIcon("calendar-clock", "时间块规划", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-timeblock-view",
      name: "打开时间块规划视图",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "create-timeblock",
      name: "新建时间块（今天）",
      callback: async () => {
        const view = await this.activateView();
        if (view instanceof TimeblockView) {
          await view.openNewBlockModal(moment());
        }
      },
    });

    this.addCommand({
      id: "switch-week-view",
      name: "切换到周视图",
      callback: async () => {
        const view = await this.activateView();
        if (view instanceof TimeblockView) {
          view.viewMode = view.viewMode === "week" ? "day" : "week";
          view.weekStart = moment().startOf("isoWeek");
          await view.reloadAll();
        }
      },
    });

    this.addCommand({
      id: "manage-goals",
      name: "新建/管理目标",
      callback: async () => {
        const view = await this.activateView();
        if (view instanceof TimeblockView) {
          await view.openNewGoalModal();
        }
      },
    });

    this.addSettingTab(new TimeblockSettingTab(this.app, this));

    // 外部修改（手机端 / 其他编辑器 / 手动编辑）时刷新视图
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile)) return;
        this.refreshViewIfRelevant(file);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!(file instanceof TFile)) return;
        this.refreshViewIfRelevant(file);
      })
    );
  }

  private refreshTimer = 0;
  /** 插件自己写入的文件（路径 → 时间戳），避免自己的保存触发自己全量刷新 */
  private selfWrites = new Map<string, number>();

  markSelfWrite(path: string) {
    this.selfWrites.set(path, Date.now());
  }

  private isSelfWrite(path: string): boolean {
    const t = this.selfWrites.get(path);
    if (t == null) return false;
    this.selfWrites.delete(path);
    // 超过 10 秒仍未消费的事件视为过期，当作外部修改处理
    return Date.now() - t <= 10000;
  }

  private refreshViewIfRelevant(file: TFile) {
    if (this.isSelfWrite(file.path)) return;
    const s = this.settings;
    const inScheduleFolder = file.parent && file.parent.path === s.scheduleFolder;
    const isGoalsFile = file.path === s.goalsFile;
    if (!inScheduleFolder && !isGoalsFile) return;
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = 0;
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        const v = leaf.view;
        if (v instanceof TimeblockView) v.reloadAll();
      }
    }, 500);
  }

  onunload() {
    // ItemView 生命周期由 workspace 管理，无需手动 detach
  }

  async activateView(): Promise<any> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE);
    let leaf: WorkspaceLeaf;
    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = workspace.getRightLeaf(false) || workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
    return leaf.view;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

/* ============================================================
 * 设置页
 * ============================================================ */

class TimeblockSettingTab extends PluginSettingTab {
  plugin: TimeblockPlannerPlugin;

  constructor(app: any, plugin: TimeblockPlannerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "时间块规划师" });
    containerEl.createEl("p", {
      text: "时间块保存在 Markdown 日笔记中，目标保存在目标库笔记中，完全可用其他工具同步。",
    });

    new Setting(containerEl)
      .setName("日程笔记文件夹")
      .setDesc("每日一个笔记，如 时间块规划/日程/2026-11-13.md")
      .addText((t) =>
        t.setValue(this.plugin.settings.scheduleFolder).onChange(async (v) => {
          this.plugin.settings.scheduleFolder = v.replace(/^\/+|\/+$/g, "");
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("目标库文件路径")
      .setDesc("如 时间块规划/目标库.md")
      .addText((t) =>
        t.setValue(this.plugin.settings.goalsFile).onChange(async (v) => {
          this.plugin.settings.goalsFile = v.replace(/^\/+|\/+$/g, "");
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("时间轴开始小时")
      .addText((t) => {
        t.inputEl.type = "number";
        t.setValue(String(this.plugin.settings.startHour));
        t.onChange(async (v) => {
          this.plugin.settings.startHour = Math.min(Math.max(parseInt(v) || 6, 0), 20);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("时间轴结束小时")
      .addText((t) => {
        t.inputEl.type = "number";
        t.setValue(String(this.plugin.settings.endHour));
        t.onChange(async (v) => {
          this.plugin.settings.endHour = Math.min(Math.max(parseInt(v) || 24, 8), 24);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("每小时像素高度")
      .setDesc("时间轴的缩放密度，默认 72")
      .addText((t) => {
        t.inputEl.type = "number";
        t.setValue(String(this.plugin.settings.pxPerHour));
        t.onChange(async (v) => {
          this.plugin.settings.pxPerHour = Math.min(Math.max(parseInt(v) || 72, 40), 200);
          await this.plugin.saveSettings();
        });
      });
  }
}
