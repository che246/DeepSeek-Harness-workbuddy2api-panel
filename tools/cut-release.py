#!/usr/bin/env python3
"""按 package.json 的版本切一次发布：打 tag → 推 tag → 建 GitHub Release → 上传 npm pack 产物。

只用标准库，不装依赖。凭据取 `GITHUB_TOKEN`，没有就从 `~/.git-credentials`（git 的
store helper）里取 github.com 那一条；仓库地址从 `git remote get-url origin` 读，
所以这个脚本不绑定任何具体仓库。

用法：
    python tools/cut-release.py                 # 打 tag + 建 Release + 上传 tgz
    python tools/cut-release.py --dry-run       # 只打印将要做什么，不写任何远端状态
    python tools/cut-release.py --tag-only      # 只打并推 tag，不建 Release
    python tools/cut-release.py --notes FILE    # 指定发布说明（缺省 docs/release-notes-v<版本>.md）

注意：tag 一旦推出去就等于对外承诺了这个版本号，所以脚本只做「新 tag」，已存在的 tag
不会被动；Release 若已存在则复用并只补缺失的附件。
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent


def run(args: list[str], *, check: bool = True, capture: bool = True) -> str:
    """跑一条命令，默认捕获 stdout；失败时把 stderr 一起抛出来。

    Windows 上 `npm` 只有 `npm.cmd`，subprocess 直接调会 FileNotFoundError，所以先用
    `shutil.which` 把可执行文件解析成全路径（`git.exe` 之类本来就找得到，解析后同样可用）。
    """
    executable = shutil.which(args[0]) or args[0]
    result = subprocess.run([executable, *args[1:]], cwd=ROOT, text=True, capture_output=capture, encoding='utf-8', errors='replace')
    if check and result.returncode != 0:
        sys.exit(f'命令失败：{" ".join(args)}\n{(result.stderr or "").strip()}')
    return (result.stdout or '').strip()


def package_manifest() -> dict:
    return json.loads((ROOT / 'package.json').read_text('utf-8'))


def package_version() -> str:
    return package_manifest()['version']


def origin_slug() -> str:
    """从 origin 远端里抠出 `owner/repo`。"""
    url = run(['git', 'remote', 'get-url', 'origin'])
    match = re.search(r'github\.com[:/]([^/]+)/([^/\s]+?)(?:\.git)?$', url)
    if match is None:
        sys.exit(f'无法从 origin 解析 owner/repo：{url}')
    return f'{match.group(1)}/{match.group(2)}'


def github_token() -> str:
    from_env = os.environ.get('GITHUB_TOKEN') or os.environ.get('GH_TOKEN')
    if from_env:
        return from_env.strip()
    credentials = pathlib.Path(os.path.expanduser('~/.git-credentials'))
    if credentials.exists():
        match = re.search(r'https://[^:]+:([^@]+)@github\.com', credentials.read_text('utf-8', 'ignore'))
        if match is not None:
            return match.group(1)
    sys.exit('没有可用凭据：请设 GITHUB_TOKEN，或让 git 的 store helper 里存有 github.com 的 token')


def api(url: str, token: str, *, data: bytes | None = None, method: str | None = None,
        content_type: str = 'application/json', allow_404: bool = False) -> object:
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header('Authorization', f'token {token}')
    request.add_header('Accept', 'application/vnd.github+json')
    request.add_header('User-Agent', 'dsh-workbuddy2api-connect-cut-release')
    if data is not None:
        request.add_header('Content-Type', content_type)
    try:
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as error:
        if allow_404 and error.code == 404:
            return None
        detail = error.read().decode('utf-8', 'ignore')[:400]
        sys.exit(f'GitHub API {error.code}：{url}\n{detail}')


def install_section(slug: str, tag: str, asset: str) -> str:
    """两条安装路径：桌面版（手工改配置 + install，避开 add 的 bundles 重写）与 Web/TUI（直接吃 URL）。"""
    url = f'https://github.com/{slug}/releases/download/{tag}/{asset}'
    return (
        '\n## 安装\n\n'
        '### 桌面版\n\n'
        '桌面版的 `desktop` profile 由 App 独占管理（独立 CLI 的 `--dump-config` 之类会被拒绝），'
        '但装包这条路是通的。\n\n'
        '**建议手工改两处再 install**——`dsh plugin add` 会重写 `dsh.profile.bundles`，实测会把其它'
        '第三方 bundle 从列表里挤掉（本机丢过 `dsh-workbuddy-connect` 与 '
        '`@eghrhegpe/dsh-connect-qoder`）；而 `install` 只装依赖、不动配置。\n\n'
        '```powershell\n'
        f'# 0) 附件地址：{url}\n'
        f'copy {asset} "$env:USERPROFILE\\.dsh\\local-plugins\\"\n'
        '```\n\n'
        '然后编辑 `%USERPROFILE%\\.dsh\\profiles\\desktop\\package.json` 两处：\n\n'
        f'- `dependencies` 里加 `"dsh-workbuddy2api-connect": "file:C:/Users/<你>/.dsh/local-plugins/{asset}"`\n'
        '- `dsh.profile.bundles` 里追加 `"dsh-workbuddy2api-connect"`\n\n'
        '```powershell\n'
        'cd "$env:USERPROFILE\\.dsh\\profiles\\desktop"\n'
        '$dsh = "D:\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd"   # 换成你的安装目录\n'
        '& $dsh plugin --profile desktop install\n'
        '```\n\n'
        '> 也可以用 `& $dsh plugin --profile desktop add "<附件路径>"`（自动写依赖与 bundles），'
        '但装完**务必核对 `dsh.profile.bundles`**，少了别的插件就补回去。\n\n'
        '### Web / TUI\n\n'
        '```sh\n'
        f'dsh plugin --profile web add {url}\n'
        '```\n\n'
        '两种方式装完都要**重启一次 DSH**：provider 路由与浏览器卡片都在 boot 时装配。'
        '重启后「插件」页出现本插件的配置卡片，模型选择器出现配置好的分组。\n'
    )


def release_body(notes: str, slug: str, tag: str, asset: str) -> str:
    """发布说明 + 安装说明；说明里自己写了 `## 安装` 就不重复追加。"""
    if '## 安装' in notes:
        return notes
    return f'{notes}\n{install_section(slug, tag, asset)}'


def release_title(tag: str, notes: str) -> str:
    """标题取发布说明的第一行；那一行只是版本号时退回包描述。"""
    first = notes.splitlines()[0].lstrip('# ').strip() if notes else ''
    if first and first not in {tag, tag.lstrip('v'), package_version()}:
        return f'{tag} — {first}'
    description = package_manifest().get('description', '')
    headline = re.split(r'[—，,。]', description)[0].strip()
    return f'{tag} — {headline}' if headline else tag


def tag_message(tag: str, notes: str) -> str:
    """tag 的说明：取发布说明里第一行「有内容」的行，跳过只写着版本号的标题行。"""
    for line in notes.splitlines():
        text = line.strip()
        if text and text.lstrip('# ').strip() not in {tag, tag.lstrip('v')}:
            return text.lstrip('# ').strip()
    return release_title(tag, notes)


def main() -> None:
    parser = argparse.ArgumentParser(description='切一次发布')
    parser.add_argument('--notes', help='发布说明文件（缺省 docs/release-notes-v<版本>.md）')
    parser.add_argument('--dry-run', action='store_true', help='只打印计划，不动远端')
    parser.add_argument('--tag-only', action='store_true', help='只打并推 tag')
    parser.add_argument('--body-only', action='store_true', help='只按发布说明重写已有 Release 的正文（不动 tag 与附件）')
    args = parser.parse_args()

    version = package_version()
    tag = f'v{version}'
    slug = origin_slug()
    notes_path = pathlib.Path(args.notes) if args.notes else ROOT / 'docs' / f'release-notes-{tag}.md'
    notes = notes_path.read_text('utf-8').strip() if notes_path.exists() else f'{tag} —— 见 README 与 tag 说明。'
    if not notes_path.exists():
        print(f'提示：{notes_path.relative_to(ROOT)} 不存在，发布说明用默认文案')

    tag_exists = run(['git', 'tag', '-l', tag]) == tag
    asset_name = f'{package_manifest()["name"]}-{version}.tgz'
    asset_path = ROOT / asset_name

    if args.body_only:
        if args.dry_run:
            print(f'--dry-run：将把 {slug} 的 {tag} Release 正文重写为 {len(release_body(notes, slug, tag, asset_name))} 字符')
            return
        token = github_token()
        release = api(f'https://api.github.com/repos/{slug}/releases/tags/{tag}', token, allow_404=True)
        if not isinstance(release, dict) or not release.get('id'):
            sys.exit(f'{tag} 还没有 Release，先跑一次完整的 cut-release.py')
        payload = json.dumps({'body': release_body(notes, slug, tag, asset_name)}, ensure_ascii=False).encode('utf-8')
        updated = api(f'https://api.github.com/repos/{slug}/releases/{release["id"]}', token, data=payload, method='PATCH')
        print(f'已重写正文：{updated["html_url"]}（{len(updated["body"])} 字符）')
        return

    print(f'仓库      : {slug}')
    print(f'版本      : {version} → tag {tag}（{"已存在" if tag_exists else "将新建"}）')
    print(f'发布说明  : {notes_path if notes_path.exists() else "（默认文案）"}')
    print(f'附件      : {asset_name}')
    if args.dry_run:
        print('\n--dry-run：不做任何写操作')
        return

    if not tag_exists:
        run(['git', 'tag', '-a', tag, '-m', tag_message(tag, notes)])
        print(f'已创建 tag {tag}')
    run(['git', 'push', 'origin', tag])
    print(f'已推送 tag {tag}')

    if args.tag_only:
        print('\n--tag-only：跳过 Release')
        return

    # npm pack 产出的 tgz 就是发布附件；先确保它是最新构建
    run(['npm', 'pack', '--silent'])
    if not asset_path.exists():
        sys.exit(f'没有找到 {asset_name}：npm pack 没产出？')
    print(f'附件就绪  : {asset_name}（{asset_path.stat().st_size} 字节）')

    token = github_token()
    release = api(f'https://api.github.com/repos/{slug}/releases/tags/{tag}', token, allow_404=True)
    if isinstance(release, dict) and release.get('id'):
        print(f'复用已有 release：{release["html_url"]}')
    else:
        payload = json.dumps({
            'tag_name': tag,
            'name': release_title(tag, notes),
            'body': release_body(notes, slug, tag, asset_name),
            'draft': False,
            'prerelease': False,
        }, ensure_ascii=False).encode('utf-8')
        release = api(f'https://api.github.com/repos/{slug}/releases', token, data=payload, method='POST')
        print(f'已创建 release：{release["html_url"]}')

    assets = api(f'https://api.github.com/repos/{slug}/releases/{release["id"]}/assets', token)
    existing = [asset for asset in assets if asset.get('name') == asset_name]
    if existing:
        print(f'附件已存在，跳过上传：{existing[0]["browser_download_url"]}')
    else:
        uploaded = api(
            f'https://uploads.github.com/repos/{slug}/releases/{release["id"]}/assets?name={asset_name}',
            token,
            data=asset_path.read_bytes(),
            method='POST',
            content_type='application/gzip',
        )
        print(f'已上传附件：{uploaded["browser_download_url"]}（{uploaded["size"]} 字节）')

    print(f'\n发布完成：https://github.com/{slug}/releases/tag/{tag}')


if __name__ == '__main__':
    main()
