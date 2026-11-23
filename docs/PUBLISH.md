# 发布清单（给自己看）

## 一、把仓库推上 GitHub

在 `obsidian-ui-zh` 目录里：

```bash
git remote add origin https://github.com/<你的用户名>/obsidian插件汉化.git
git branch -M main
git push -u origin main
git push origin 0.2.2
```

> 仓库名带中文，GitHub 接受，但地址会被编码成 `obsidian%E6%8F%92%E4%BB%B6%E6%B1%89%E5%8C%96`。
> 如果以后觉得别扭，在 GitHub 设置里改名即可，**旧链接会自动 301 跳转**，不影响已安装用户。

## 二、创建 Release（L1 的关键，也是 BRAT 的唯一来源）

1. GitHub → Releases → Draft a new release
2. Tag：`0.2.2`（必须与 `manifest.json` 的 version 完全一致）
3. 标题：`0.2.2`
4. **上传三个附件**（缺一不可）：
   - `main.js`
   - `manifest.json`
   - `styles.css`
5. 发布

> 只上传这三个文件。BRAT 和 Obsidian 都只从这里取，附件里塞源码压缩包会让体积翻倍。

## 三、BRAT 安装（给自己和朋友）

BRAT → Add Beta plugin → 输入：

```
<你的用户名>/obsidian插件汉化
```

如果 BRAT 对中文仓库名报错，改用编码后的名字，或直接把仓库改名为 `obsidian-ui-zh`（旧链接仍可跳转）。

## 四、每次发新版本的固定动作

```bash
# 1. 改 manifest.json 的 version（例如 0.2.3）
# 2. 改 versions.json，加一行 "0.2.3": "1.4.0"
# 3. 写 CHANGELOG.md
git add -A
git commit -m "0.2.3: ..."
git tag 0.2.3
git push && git push --tags
# 4. 在 GitHub 建同名 Release，上传三个文件
```

## 五、发布前自检（每次都过一遍）

- [ ] `git status` 里**没有** `data.json` / `state.json` / `boot-error.txt`
- [ ] `grep -r "sk-" .` 只命中 README 里的占位符 `sk-...`
- [ ] `grep -r "F:\\\\" .` 没有本地绝对路径
- [ ] `manifest.json` 的 `version` == git tag == Release tag
- [ ] `node --check main.js` 通过
- [ ] 三件套（main.js / manifest.json / styles.css）都在 Release 附件里

## 六、以后想上官方市场（L3）再做

1. fork `obsidianmd/obsidian-releases`
2. 在 `community-plugins.json` 末尾加 `"obsidian-ui-zh"`
3. 提 PR；机器人会校验仓库、tag、附件、LICENSE
4. 人工 review 时可能追问「修改其他插件 DOM」的合规性，README 与 PRIVACY 里已有说明可直接引用
