const { Plugin, PluginSettingTab, Setting, Notice, requestUrl } = require("obsidian");

const DEFAULT_SETTINGS = {
	token: "",
	repo: "",
	branch: "main"
};

class ObsidianImageUploaderPlugin extends Plugin {
	async onload() {
		await this.loadSettings();
		this.addSettingTab(new ObsidianImageUploaderSettingTab(this.app, this));

		this.registerEvent(
			this.app.workspace.on("editor-paste", async (evt, editor) => {
				await this.handleEditorPaste(evt, editor);
			})
		);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async handleEditorPaste(evt, editor) {
		const clipboardData = evt.clipboardData;
		if (!clipboardData || !clipboardData.items || clipboardData.items.length === 0) {
			return;
		}

		const imageFiles = [];
		for (const item of clipboardData.items) {
			if (item.kind === "file" && item.type.startsWith("image/")) {
				const file = item.getAsFile();
				if (file) imageFiles.push(file);
			}
		}

		if (imageFiles.length === 0) return;

		if (!this.isConfigValid()) {
			new Notice("请先配置有效的 GitHub Token、仓库(owner/repo)和分支。");
			return;
		}

		evt.preventDefault();
		evt.stopPropagation();

		const markdownLines = [];
		const failedFiles = [];
		const failedReasons = [];

		for (const file of imageFiles) {
			try {
				const imagePath = this.buildImagePath(file);
				const rawUrl = await this.uploadWithRetry(file, imagePath, 3);
				markdownLines.push(`![](${rawUrl})`);
			} catch (error) {
				console.error("Image upload failed:", error);
				failedFiles.push(file.name || "clipboard-image");
				failedReasons.push(this.errorMessage(error));
			}
		}

		if (markdownLines.length > 0) {
			editor.replaceSelection(markdownLines.join("\n"));
		}

		if (failedFiles.length > 0) {
			const reason = failedReasons[0] ? `，原因: ${failedReasons[0]}` : "";
			new Notice(`图片上传失败（已重试3次）: ${failedFiles.join(", ")}${reason}`, 10000);
		}
	}

	isConfigValid() {
		const repo = this.normalizeRepo(this.settings.repo);
		return Boolean(
			this.settings.token &&
			repo &&
			/^[^/\s]+\/[^/\s]+$/.test(repo) &&
			this.settings.branch
		);
	}

	normalizeRepo(repo) {
		if (!repo) return "";
		let normalized = String(repo).trim();
		normalized = normalized.replace(/^https?:\/\/github\.com\//i, "");
		normalized = normalized.replace(/\.git$/i, "");
		normalized = normalized.replace(/^\/+|\/+$/g, "");
		return normalized;
	}

	buildImagePath(file) {
		const now = new Date();
		const year = String(now.getFullYear());
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const timestamp = this.formatTimestamp(now);
		const originalName = file.name || "pasted-image";
		const parsed = this.parseAndSanitizeFileName(originalName, file.type);
		return `images/${year}/${month}/${timestamp}-${parsed.baseName}.${parsed.ext}`;
	}

	formatTimestamp(date) {
		const y = date.getFullYear();
		const m = String(date.getMonth() + 1).padStart(2, "0");
		const d = String(date.getDate()).padStart(2, "0");
		const hh = String(date.getHours()).padStart(2, "0");
		const mm = String(date.getMinutes()).padStart(2, "0");
		const ss = String(date.getSeconds()).padStart(2, "0");
		const ms = String(date.getMilliseconds()).padStart(3, "0");
		return `${y}${m}${d}${hh}${mm}${ss}${ms}`;
	}

	parseAndSanitizeFileName(name, mimeType) {
		const lastDot = name.lastIndexOf(".");
		let baseName = lastDot > 0 ? name.slice(0, lastDot) : name;
		let ext = lastDot > 0 ? name.slice(lastDot + 1) : "";
		baseName = this.sanitizeName(baseName || "pasted-image");
		ext = this.sanitizeExtension(ext || this.extFromMime(mimeType));
		if (!ext) ext = "png";
		return { baseName, ext };
	}

	sanitizeName(name) {
		return (
			name
				.replace(/[^\w.-]+/g, "-")
				.replace(/-+/g, "-")
				.replace(/^-|-$/g, "")
				.toLowerCase() || "pasted-image"
		);
	}

	sanitizeExtension(ext) {
		return String(ext || "")
			.replace(/[^a-zA-Z0-9]/g, "")
			.toLowerCase();
	}

	extFromMime(mimeType) {
		const map = {
			"image/png": "png",
			"image/jpeg": "jpg",
			"image/jpg": "jpg",
			"image/webp": "webp",
			"image/gif": "gif",
			"image/svg+xml": "svg",
			"image/bmp": "bmp"
		};
		return map[mimeType] || "png";
	}

	async uploadWithRetry(file, imagePath, maxAttempts) {
		let lastError = null;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return await this.uploadToGithub(file, imagePath);
			} catch (error) {
				lastError = error;
				if (attempt < maxAttempts) {
					await this.sleep(attempt * 500);
				}
			}
		}
		throw lastError;
	}

	async uploadToGithub(file, imagePath) {
		const repo = this.normalizeRepo(this.settings.repo);
		const [owner, repoName] = repo.split("/");
		const encodedPath = imagePath
			.split("/")
			.map((segment) => encodeURIComponent(segment))
			.join("/");
		const apiUrl = `https://api.github.com/repos/${owner}/${repoName}/contents/${encodedPath}`;
		const contentBase64 = await this.fileToBase64(file);
		const commitMessage = `chore: upload image ${imagePath}`;
		const payloadWithBranch = {
			message: commitMessage,
			content: contentBase64,
			branch: this.settings.branch
		};

		let lastError = null;
		// Try PAT classic style first (`token xxx`), then bearer.
		for (const authHeader of [`token ${this.settings.token}`, `Bearer ${this.settings.token}`]) {
			try {
				await this.ensureRepoReachable(owner, repoName, authHeader);
				await this.ensureBranchExists(owner, repoName, this.settings.branch, authHeader);
				await requestUrl({
					url: apiUrl,
					method: "PUT",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/vnd.github+json",
						Authorization: authHeader,
						"X-GitHub-Api-Version": "2022-11-28"
					},
					body: JSON.stringify(payloadWithBranch)
				});
				const branch = this.settings.branch;
				return `https://raw.githubusercontent.com/${repo}/${branch}/${encodedPath}`;
			} catch (error) {
				lastError = error;
			}
		}

		throw lastError || new Error("unknown upload error");
	}

	async ensureRepoReachable(owner, repoName, authHeader) {
		try {
			const response = await requestUrl({
				url: `https://api.github.com/repos/${owner}/${repoName}`,
				method: "GET",
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: authHeader,
					"X-GitHub-Api-Version": "2022-11-28"
				}
			});
			const data = response.json || {};
			if (data.permissions && data.permissions.push === false) {
				throw new Error(
					`GitHub 仓库不可写: ${owner}/${repoName}。当前 Token 只有读取权限，请更换为可写仓库或有写权限的 Token。`
				);
			}
		} catch (error) {
			const status = this.extractStatus(error);
			if (status === 404) {
				throw new Error(
					`GitHub API 404: 无法访问仓库 ${owner}/${repoName}。请确认仓库名为 owner/repo，且 Token 已授权该仓库并具备 Contents 写权限。`
				);
			}
			if (status === 401) {
				throw new Error("GitHub API 401: Token 无效或已过期。");
			}
			if (status === 403) {
				throw new Error("GitHub API 403: Token 权限不足，需仓库 Contents 读写权限。");
			}
			throw error;
		}
	}

	async getDefaultBranch(owner, repoName, authHeader) {
		try {
			const response = await requestUrl({
				url: `https://api.github.com/repos/${owner}/${repoName}`,
				method: "GET",
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: authHeader,
					"X-GitHub-Api-Version": "2022-11-28"
				}
			});
			const data = response.json;
			if (data && data.default_branch) {
				return data.default_branch;
			}
		} catch (error) {
			// Ignore and fallback to configured branch.
		}
		return this.settings.branch || "main";
	}

	async ensureBranchExists(owner, repoName, branch, authHeader) {
		const encodedBranch = encodeURIComponent(branch);
		try {
			await requestUrl({
				url: `https://api.github.com/repos/${owner}/${repoName}/branches/${encodedBranch}`,
				method: "GET",
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: authHeader,
					"X-GitHub-Api-Version": "2022-11-28"
				}
			});
			return { created: false, baseBranch: branch };
		} catch (error) {
			const status = this.extractStatus(error);
			if (status !== 404) throw error;
		}

		const defaultBranch = await this.getDefaultBranch(owner, repoName, authHeader);
		const baseSha = await this.getBranchHeadSha(owner, repoName, defaultBranch, authHeader);

		try {
			await requestUrl({
				url: `https://api.github.com/repos/${owner}/${repoName}/git/refs`,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/vnd.github+json",
					Authorization: authHeader,
					"X-GitHub-Api-Version": "2022-11-28"
				},
				body: JSON.stringify({
					ref: `refs/heads/${branch}`,
					sha: baseSha
				})
			});
			return { created: true, baseBranch: defaultBranch };
		} catch (error) {
			// Branch may have been created by another request.
			if (this.extractStatus(error) === 422) {
				return { created: false, baseBranch: defaultBranch };
			}
			throw error;
		}
	}

	async getBranchHeadSha(owner, repoName, branch, authHeader) {
		const response = await requestUrl({
			url: `https://api.github.com/repos/${owner}/${repoName}/branches/${encodeURIComponent(branch)}`,
			method: "GET",
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: authHeader,
				"X-GitHub-Api-Version": "2022-11-28"
			}
		});
		const sha = response.json && response.json.commit && response.json.commit.sha;
		if (!sha) {
			throw new Error(`无法获取分支 ${branch} 的最新提交 SHA。`);
		}
		return sha;
	}

	async fileToBase64(file) {
		const arrayBuffer = await file.arrayBuffer();
		const bytes = new Uint8Array(arrayBuffer);
		let binary = "";
		const chunkSize = 0x8000;

		for (let i = 0; i < bytes.length; i += chunkSize) {
			const chunk = bytes.subarray(i, i + chunkSize);
			binary += String.fromCharCode.apply(null, chunk);
		}

		return btoa(binary);
	}

	sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	errorMessage(error) {
		const msg = error && error.message ? String(error.message) : String(error || "unknown error");
		return msg.length > 180 ? `${msg.slice(0, 180)}...` : msg;
	}

	extractStatus(error) {
		if (!error) return null;
		if (typeof error.status === "number") return error.status;
		const message = String(error.message || error);
		const match = message.match(/status\s+(\d{3})/i) || message.match(/\b(\d{3})\b/);
		return match ? Number(match[1]) : null;
	}

	async testConnection() {
		const repo = this.normalizeRepo(this.settings.repo);
		if (!this.isConfigValid()) {
			new Notice("配置无效：请确认 Token、仓库(owner/repo)和分支均已填写。", 8000);
			return;
		}

		const [owner, repoName] = repo.split("/");
		let lastError = null;

		for (const authHeader of [`token ${this.settings.token}`, `Bearer ${this.settings.token}`]) {
			try {
				await this.ensureRepoReachable(owner, repoName, authHeader);
				const branchResult = await this.ensureBranchExists(
					owner,
					repoName,
					this.settings.branch,
					authHeader
				);
				if (branchResult.created) {
					new Notice(
						`连接成功：${repo}@${this.settings.branch} 可写；分支不存在，已基于 ${branchResult.baseBranch} 自动创建。`,
						10000
					);
				} else {
					new Notice(`连接成功：${repo}@${this.settings.branch} 可写。`, 8000);
				}
				return;
			} catch (error) {
				lastError = error;
			}
		}

		new Notice(`连接失败: ${this.errorMessage(lastError)}`, 10000);
	}
}

class ObsidianImageUploaderSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Obsidian Image Uploader" });

		new Setting(containerEl)
			.setName("GitHub Token")
			.setDesc("用于上传文件到 GitHub 的 Token（需要 repo 内容写入权限）")
			.addText((text) => {
				text.setPlaceholder("ghp_xxx")
					.setValue(this.plugin.settings.token)
					.onChange(async (value) => {
						this.plugin.settings.token = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		new Setting(containerEl)
			.setName("Repository")
			.setDesc("目标仓库，格式：owner/repo")
			.addText((text) =>
				text
					.setPlaceholder("owner/repo")
					.setValue(this.plugin.settings.repo)
					.onChange(async (value) => {
						this.plugin.settings.repo = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Branch")
			.setDesc("目标分支，例如 main")
			.addText((text) =>
				text
					.setPlaceholder("main")
					.setValue(this.plugin.settings.branch)
					.onChange(async (value) => {
						this.plugin.settings.branch = value.trim() || "main";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Test Connection")
			.setDesc("检测 Token、仓库和分支是否可用且可写")
			.addButton((button) =>
				button.setButtonText("Test").onClick(async () => {
					button.setDisabled(true);
					const oldText = button.buttonEl.textContent;
					button.setButtonText("Testing...");
					try {
						await this.plugin.testConnection();
					} finally {
						button.setButtonText(oldText || "Test");
						button.setDisabled(false);
					}
				})
			);
	}
}

module.exports = ObsidianImageUploaderPlugin;
