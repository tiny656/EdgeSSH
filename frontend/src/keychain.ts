import { createElement, KeyRound, Plus, RefreshCw, Copy, Download, Pencil, Trash2, X, Terminal } from 'lucide';
import { listKeychain, saveKeychainKey, removeKeychainKey, exportKeychainKey, generateKeychainKey, type KeychainKey } from './cloud-api';
import './keychain.css';

export function fillKeychainSelect(select: HTMLSelectElement, keys: KeychainKey[], selected = select.value): void {
  select.replaceChildren(new Option('选择密钥', ''));
  for (const key of keys) select.add(new Option(`${key.name} · ${key.publicKey.split(' ')[0]}`, key.id));
  if (selected && !keys.some((key) => key.id === selected)) select.add(new Option('密钥不可用，请重新选择', selected));
  select.value = selected;
}

export class Keychain extends EventTarget {
  readonly root = document.createElement('section');
  keys: KeychainKey[] = [];
  private generation = 0;
  private editorGeneration = 0;
  private editing?: KeychainKey;
  private busy = false;
  private returnFocus?: HTMLElement;
  private readonly dialog: HTMLDialogElement;
  private readonly form: HTMLFormElement;

  constructor(openTerminal: () => void) {
    super();
    this.root.className = 'keychain-page'; this.root.hidden = true;
    this.root.innerHTML = `<header class="keychain-heading"><h1 tabindex="-1">密钥链</h1>
      <div class="keychain-heading-actions"><button type="button" class="home-button" data-terminal aria-label="返回终端" title="返回终端"></button>
      <button type="button" class="home-button primary" data-new>新建密钥</button></div></header>
      <div class="keychain-toolbar"><input type="search" aria-label="搜索密钥" placeholder="搜索名称或指纹">
      <button type="button" class="home-button" data-refresh aria-label="刷新密钥" title="刷新密钥"></button></div>
      <p class="keychain-status" role="status" hidden></p><div class="keychain-list"></div>
      <dialog class="host-dialog keychain-dialog" aria-labelledby="keychain-dialog-title"><form autocomplete="off">
        <div class="dialog-heading"><h2 id="keychain-dialog-title">新建密钥</h2><button type="button" class="home-button" data-close aria-label="关闭" title="关闭"></button></div>
        <div class="host-form-grid">
          <label class="wide">名称<input name="name" maxlength="80" required></label>
          <div class="wide keychain-key-actions"><button type="button" class="home-button" data-generate title="生成 Ed25519 密钥">生成</button></div>
          <label class="wide">私钥<textarea name="privateKey" rows="6" maxlength="65536" spellcheck="false" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea></label>
          <label class="wide">私钥文件<input name="file" type="file" accept=".pem,.key,.openssh,text/plain"></label>
          <label class="wide">公钥<textarea name="publicKey" rows="3" maxlength="16384" spellcheck="false" placeholder="ssh-ed25519 …"></textarea></label>
        </div>
        <p class="credential-help" data-key-help></p>
        <p class="host-form-error" role="alert" hidden></p>
        <div class="dialog-actions"><button type="button" class="home-button" data-close>取消</button><button class="home-button primary" type="submit">保存</button></div>
      </form></dialog>`;
    this.dialog = this.root.querySelector('dialog')!;
    this.form = this.dialog.querySelector('form')!;
    this.root.querySelector('[data-new]')!.prepend(createElement(Plus));
    this.root.querySelector('[data-terminal]')!.append(createElement(Terminal));
    this.root.querySelector('[data-terminal]')!.addEventListener('click', openTerminal);
    this.root.querySelector('[data-refresh]')!.append(createElement(RefreshCw));
    this.root.querySelector('[data-generate]')!.prepend(createElement(KeyRound));
    this.root.querySelector('[data-generate]')!.addEventListener('click', () => void this.generate());
    this.root.querySelector('[aria-label="关闭"]')!.append(createElement(X));
    this.root.querySelector('[data-new]')!.addEventListener('click', () => this.open());
    this.root.querySelector('[data-refresh]')!.addEventListener('click', () => void this.load());
    this.root.querySelector('input[type="search"]')!.addEventListener('input', () => this.render());
    this.root.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => { if (!this.busy) this.dialog.close(); }));
    this.dialog.addEventListener('cancel', (event) => { if (this.busy) event.preventDefault(); });
    this.dialog.addEventListener('close', () => { this.form.reset(); this.editing = undefined; this.editorGeneration++; this.returnFocus?.focus(); });
    this.field('file').addEventListener('change', () => void this.readFile());
    this.form.addEventListener('submit', (event) => { event.preventDefault(); void this.save(); });
    window.addEventListener('auth-required', () => this.clear());
  }

  private field(name: string): HTMLInputElement | HTMLTextAreaElement {
    return this.form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement;
  }

  async load(): Promise<void> {
    const generation = this.generation;
    const button = this.root.querySelector<HTMLButtonElement>('[data-refresh]')!;
    button.disabled = true; this.message('正在加载密钥…');
    try {
      const keys = await listKeychain();
      if (generation !== this.generation) return;
      this.keys = keys; this.render(); this.message(''); this.dispatchEvent(new Event('change'));
    } catch (error) { if (generation === this.generation) this.message(error instanceof Error ? error.message : '密钥加载失败。'); }
    finally { button.disabled = false; }
  }

  show(): void { this.root.hidden = false; void this.load(); this.root.querySelector('h1')!.focus(); }
  hide(): void { this.root.hidden = true; }
  clear(): void { this.generation++; this.keys = []; this.dialog.close(); this.form.reset(); this.render(); this.dispatchEvent(new Event('change')); }

  private message(text: string): void {
    const status = this.root.querySelector<HTMLElement>('.keychain-status')!; status.textContent = text; status.hidden = !text;
  }

  private render(): void {
    const list = this.root.querySelector<HTMLElement>('.keychain-list')!; list.replaceChildren();
    const query = this.root.querySelector<HTMLInputElement>('input[type="search"]')!.value.trim().toLowerCase();
    const keys = this.keys.filter((key) => `${key.name} ${key.fingerprint}`.toLowerCase().includes(query));
    if (!keys.length) { const empty = document.createElement('p'); empty.className = 'home-empty'; empty.textContent = query ? '没有匹配的密钥' : '暂无密钥'; list.append(empty); }
    for (const key of keys) {
      const row = document.createElement('article'); row.className = 'keychain-row';
      const details = document.createElement('div'); details.className = 'keychain-copy';
      const name = document.createElement('strong'); name.textContent = key.name;
      const fingerprint = document.createElement('code'); fingerprint.textContent = key.fingerprint;
      const publicKey = document.createElement('textarea'); publicKey.readOnly = true; publicKey.rows = 2; publicKey.value = key.publicKey; publicKey.setAttribute('aria-label', `${key.name} 公钥`);
      const meta = document.createElement('small'); meta.textContent = `${key.publicKey.split(' ')[0]} · ${new Date(key.updatedAt).toLocaleDateString()}`;
      details.append(name, meta, fingerprint, publicKey);
      const actions = document.createElement('div'); actions.className = 'keychain-actions';
      const commands = [
        ['复制公钥', Copy, async () => { await navigator.clipboard.writeText(key.publicKey); this.message('公钥已复制。'); }],
        ['下载私钥', Download, async () => {
          if (!confirm(`下载「${key.name}」的未加密私钥？请妥善保管下载的文件。`)) return;
          const generation = this.generation;
          const { privateKey } = await exportKeychainKey(key.id);
          if (generation !== this.generation) return;
          const url = URL.createObjectURL(new Blob([privateKey + '\n'], { type: 'application/octet-stream' }));
          const link = document.createElement('a'); link.href = url; link.download = `${key.name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'edgessh'}.key`; link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }],
        ['编辑密钥', Pencil, async () => this.open(key)],
        ['删除密钥', Trash2, async () => {
          if (!confirm(`删除密钥「${key.name}」？此操作无法撤销。`)) return;
          await removeKeychainKey(key.id); await this.load();
        }],
      ] as const;
      for (const [label, icon, command] of commands) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'home-button';
        button.title = label; button.setAttribute('aria-label', `${label} ${key.name}`); button.append(createElement(icon));
        button.addEventListener('click', async () => {
          button.disabled = true;
          try { await command(); } catch (error) { this.message(error instanceof Error ? error.message : '操作失败，请重试。'); }
          finally { button.disabled = false; }
        });
        actions.append(button);
      }
      row.append(createElement(KeyRound), details, actions); list.append(row);
    }
  }

  private open(key?: KeychainKey): void {
    this.returnFocus = document.activeElement as HTMLElement;
    this.form.reset(); this.editing = key; this.editorGeneration++;
    (this.field('file') as HTMLInputElement).setCustomValidity('');
    this.field('name').value = key?.name ?? '';
    this.field('privateKey').required = !key;
    this.field('publicKey').value = key?.publicKey ?? '';
    this.dialog.querySelector('h2')!.textContent = key ? '编辑密钥' : '新建密钥';
    this.dialog.querySelector<HTMLElement>('[role="alert"]')!.hidden = true;
    this.dialog.querySelector('[data-key-help]')!.textContent = this.editing
      ? '私钥留空保留原值；更换私钥时请更新公钥或将公钥留空。'
      : '未设口令的 OpenSSH 私钥 · 公钥留空时自动提取 · 私钥加密保存。';
    this.dialog.showModal(); this.field('name').focus();
  }

  private async generate(): Promise<void> {
    if (this.busy) return;
    if ((this.field('privateKey').value.trim() || this.field('publicKey').value.trim()) && !confirm('生成新密钥并替换当前输入的公钥和私钥？')) return;
    const button = this.form.querySelector<HTMLButtonElement>('[data-generate]')!;
    const submit = this.form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    const generation = this.generation, editorGeneration = this.editorGeneration;
    this.busy = true; button.disabled = true; submit.disabled = true;
    button.lastChild!.textContent = '生成中…';
    for (const name of ['privateKey', 'publicKey', 'file']) this.field(name).disabled = true;
    this.dialog.querySelector<HTMLElement>('[role="alert"]')!.hidden = true;
    try {
      const pair = await generateKeychainKey();
      if (generation !== this.generation || editorGeneration !== this.editorGeneration) return;
      this.field('privateKey').value = pair.privateKey; this.field('publicKey').value = pair.publicKey;
      this.field('file').value = ''; this.field('file').setCustomValidity('');
    } catch (error) { if (generation === this.generation && editorGeneration === this.editorGeneration) this.formError(error); }
    finally {
      this.busy = false; button.disabled = false; submit.disabled = false; button.lastChild!.textContent = '生成';
      for (const name of ['privateKey', 'publicKey', 'file']) this.field(name).disabled = false;
    }
  }

  private async readFile(): Promise<void> {
    const input = this.field('file') as HTMLInputElement;
    const file = input.files?.[0]; input.setCustomValidity(''); if (!file) return;
    const generation = this.editorGeneration;
    input.setCustomValidity('正在读取私钥文件。');
    try {
      if (file.size > 65536) throw new Error('私钥文件不能超过 64 KiB。');
      const text = await file.text();
      if (generation === this.editorGeneration && input.files?.[0] === file) { this.field('privateKey').value = text; input.setCustomValidity(''); }
    } catch (error) {
      if (generation === this.editorGeneration) { input.setCustomValidity('私钥文件读取失败，请重新选择。'); this.formError(error); }
    }
  }

  private formError(error: unknown): void {
    const message = this.dialog.querySelector<HTMLElement>('[role="alert"]')!;
    message.textContent = error instanceof Error ? error.message : '保存失败，请重试。'; message.hidden = false;
  }

  private async save(): Promise<void> {
    if (this.busy || !this.form.reportValidity()) return;
    const button = this.form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    const generation = this.generation;
    this.busy = true; button.disabled = true; button.textContent = '保存中…';
    try {
      await saveKeychainKey({ name: this.field('name').value,
        privateKey: this.field('privateKey').value || undefined, publicKey: this.field('publicKey').value,
      }, this.editing?.id);
      if (generation !== this.generation) return;
      this.dialog.close(); await this.load();
    } catch (error) { if (generation === this.generation) this.formError(error); }
    finally { this.busy = false; button.disabled = false; button.textContent = '保存'; }
  }
}
