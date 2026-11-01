import { Copy, ExternalLink, createElement } from 'lucide';
import './agent-cli-page.css';

const docsUrl = 'https://edgessh-docs.pages.dev/usage/agent-cli';
const text = (zh: string, en: string) => `<span data-i18n-zh="${zh}" data-i18n-en="${en}">${zh}</span>`;

export class AgentCliPage {
  readonly root = document.createElement('section');

  constructor() {
    this.root.className = 'agent-cli-page';
    this.root.hidden = true;
    this.root.setAttribute('aria-labelledby', 'agent-cli-heading');
    this.root.innerHTML = `
      <header class="agent-cli-heading">
        <div><h1 id="agent-cli-heading" tabindex="-1">Agent CLI</h1>
        <p>${text('让本地 Agent 使用你的 SSH 主机与文件。', 'Connect your local agent to your SSH hosts and files.')}</p></div>
        <a class="home-button" href="${docsUrl}" target="_blank" rel="noopener noreferrer" data-docs>${text('完整文档', 'Documentation')}</a>
      </header>
      <p class="agent-cli-requirements">Node.js 22.12+ · cloudflared · Cloudflare Access</p>
      <p class="home-notice" data-provider-warning hidden>${text('当前站点使用 GitHub 登录，CLI 暂不支持。需先由管理员将站点配置为 Cloudflare Access，不能直接复用网页登录。', 'This site uses GitHub sign-in, which the CLI does not support yet. An administrator must configure Cloudflare Access first; the browser session cannot be reused.')}</p>
      <div class="agent-cli-steps">
        <section aria-labelledby="agent-cli-install"><h2 id="agent-cli-install">01 ${text('安装', 'Install')}</h2>
          <p>${text('先安装 Node.js 和官方 cloudflared，再安装 CLI。', 'Install Node.js and the official cloudflared client, then install the CLI.')}
          <a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" target="_blank" rel="noopener noreferrer">cloudflared</a></p>
          <div class="agent-cli-command"><pre><code data-command="install"></code></pre><button type="button" data-copy="install"></button></div>
        </section>
        <section aria-labelledby="agent-cli-login"><h2 id="agent-cli-login">02 ${text('认证此站点', 'Authenticate this site')}</h2>
          <p>${text('在本机终端执行，由你在浏览器完成 Access 登录。令牌到期后重新登录。', 'Run locally and complete Access sign-in in your browser. Sign in again when the token expires.')}</p>
          <div class="agent-cli-command"><pre><code data-command="login"></code></pre><button type="button" data-copy="login"></button></div>
        </section>
        <section aria-labelledby="agent-cli-connect"><h2 id="agent-cli-connect">03 ${text('交给 Agent', 'Connect your agent')}</h2>
          <p>${text('将下面内容加入 Agent 的项目指令。主机 ID 从 hosts 输出中获取。', 'Add this to your agent project instructions. Use a host ID from the hosts output.')}</p>
          <div class="agent-cli-command agent-cli-instructions"><pre><code data-command="agent"></code></pre><button type="button" data-copy="agent"></button></div>
        </section>
      </div>
      <section class="agent-cli-reference" aria-labelledby="agent-cli-commands"><h2 id="agent-cli-commands">${text('常用命令', 'Commands')}</h2>
        <div class="agent-cli-command"><pre><code data-command="commands"></code></pre><button type="button" data-copy="commands"></button></div>
        <p>${text('用主机 ID 替换 HOST_ID。exec 的命令作为一个完整参数传入；Agent 使用 --json 读取输出与退出码。', 'Replace HOST_ID with a host ID. Pass exec a single complete command argument; agents use --json for output and exit codes.')}</p>
      </section>
      <footer class="agent-cli-boundaries">
        <p>${text('CLI 与网页拥有相同的远端权限。未知或变化的主机指纹必须先核实；不向 Agent 提供 Access 令牌或 SSH 私钥。', 'The CLI has the same remote permissions as the website. Verify unknown or changed host keys; do not give your agent Access tokens or SSH private keys.')}</p>
        <p>${text('CLI 不内置 AI 或 MCP Server。上传上限 2 GiB，下载上限 64 MiB，默认拒绝覆盖，不支持断点续传。大文件需 CLI 0.2.0 及配套服务端；写入与删除前应明确授权范围并备份。', 'No built-in AI or MCP server. Uploads: 2 GiB; downloads: 64 MiB. No resume; overwrites are rejected by default. Large uploads require CLI 0.2.0 and an updated server. Authorize and back up remote changes.')}</p>
      </footer>
      <p class="agent-cli-copy-status" role="status" aria-live="polite"></p>`;

    const commands: Record<string, string> = {
      install: 'npm install --global @aozorae/edgessh',
      login: `edgessh login --url ${location.origin}\nedgessh status\nedgessh hosts`,
      agent: `Use EdgeSSH CLI for this workspace: ${location.origin}\n` +
        'List hosts with edgessh hosts. Run commands with edgessh exec HOST_ID --json -- \'command\'.\n' +
        'Use edgessh ls/get/put for files. Keep output small and check exit codes.\n' +
        'Ask the user to sign in when authentication expires. Never read or display Access tokens or SSH private keys.\n' +
        'Ask the user to verify unknown/changed host keys; do not use --accept-new on your own.\n' +
        'Only modify authorized paths. Back up before overwriting, verify changes, and clean up test files. Do not automatically retry remote commands.',
      commands: 'edgessh hosts\nedgessh exec HOST_ID --json -- \'uname -a; df -h\'\n' +
        'edgessh ls HOST_ID /var/log\nedgessh get HOST_ID /var/log/app.log ./app.log\n' +
        'edgessh put HOST_ID ./config.json /tmp/config.json',
    };
    for (const [name, command] of Object.entries(commands)) {
      this.root.querySelector(`[data-command="${name}"]`)!.textContent = command;
    }
    this.root.querySelector('[data-docs]')!.append(createElement(ExternalLink));
    const copyLabels: Record<string, [string, string]> = {
      install: ['复制安装命令', 'Copy installation command'], login: ['复制认证命令', 'Copy sign-in commands'],
      agent: ['复制 Agent 指令', 'Copy agent instructions'], commands: ['复制常用命令', 'Copy commands'],
    };
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
      const [zh, en] = copyLabels[button.dataset.copy!];
      button.className = 'agent-cli-copy';
      button.dataset.i18nTitleZh = zh; button.dataset.i18nTitleEn = en;
      button.dataset.i18nAriaLabelZh = zh; button.dataset.i18nAriaLabelEn = en;
      button.append(createElement(Copy));
      button.addEventListener('click', async () => {
        const status = this.root.querySelector<HTMLElement>('[role="status"]')!;
        const english = document.documentElement.lang === 'en';
        try {
          await navigator.clipboard.writeText(commands[button.dataset.copy!]);
          status.textContent = english ? 'Copied.' : '已复制。';
        } catch {
          status.textContent = english ? 'Clipboard unavailable. Select and copy the text.' : '剪贴板不可用，请选中文本手动复制。';
        }
      });
    }
    // 页面晚于全局语言初始化创建，首次挂载也要沿用用户已选语言。
    const english = document.documentElement.lang === 'en';
    for (const node of this.root.querySelectorAll<HTMLElement>('[data-i18n-zh]')) node.textContent = english ? node.dataset.i18nEn! : node.dataset.i18nZh!;
    for (const button of this.root.querySelectorAll<HTMLElement>('[data-copy]')) {
      button.title = english ? button.dataset.i18nTitleEn! : button.dataset.i18nTitleZh!;
      button.setAttribute('aria-label', button.title);
    }
  }

  setProvider(provider: string): void {
    this.root.querySelector<HTMLElement>('[data-provider-warning]')!.hidden = provider !== 'github';
  }

  show(): void {
    this.root.hidden = false;
    this.root.querySelector<HTMLElement>('h1')!.focus({ preventScroll: true });
  }

  hide(): void { this.root.hidden = true; }
}
