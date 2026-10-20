export async function inspectFolder(fileList) {
  const files = [...fileList];
  const manifests = files.filter((file) => file.name === 'task.json');
  if (manifests.length !== 1) throw new Error('请选择只含一个 task.json 的录音文件夹');
  const manifestFile = manifests[0];
  if (manifestFile.size > 2 * 1024 * 1024) throw new Error('task.json 超过 2 MB');
  const task = JSON.parse(await manifestFile.text());
  if (!Array.isArray(task.segments) || !task.segments.length) throw new Error('task.json 没有切片');
  const relativePath = manifestFile.webkitRelativePath || manifestFile.name;
  const directory = relativePath.slice(0, -manifestFile.name.length);
  const audio = files.filter((file) => /\.m4a$/i.test(file.name));
  const map = new Map();
  for (const file of audio) {
    if ((file.webkitRelativePath || file.name) !== `${directory}${file.name}` || map.has(file.name)) throw new Error('音频必须与 task.json 同目录，且文件名不能重复');
    if (!file.size || file.size > 100 * 1024 * 1024) throw new Error('音频为空或单片超过 100 MB');
    map.set(file.name, file);
  }
  const names = new Set();
  for (const segment of task.segments) {
    if (typeof segment.file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.m4a$/i.test(segment.file) || names.has(segment.file)) throw new Error('清单文件名非法或重复');
    names.add(segment.file);
    if (!map.has(segment.file)) throw new Error(`缺少音频：${segment.file}`);
  }
  if (map.size !== names.size) throw new Error('文件夹含未列入 task.json 的音频，请先核对清单');
  return { task, files: map, label: directory.replace(/\/$/, '') || '录音文件夹' };
}

export function mountImportPanel({ refreshRecordings, openRecording, refreshIcons }) {
  const toolbar = document.querySelector('.recording-toolbar');
  const button = document.createElement('button');
  button.className = 'import-button';
  button.type = 'button';
  button.title = '导入录音文件夹';
  button.setAttribute('aria-label', '导入录音文件夹');
  button.innerHTML = '<i data-lucide="folder-plus" aria-hidden="true"></i>导入文件夹';
  button.disabled = true;
  toolbar.append(button);
  const container = document.createElement('section');
  container.className = 'import-jobs';
  container.setAttribute('aria-label', '转写任务');
  container.innerHTML = '<p class="import-error" role="alert" hidden></p><p class="import-upload" role="status" hidden></p><details hidden><summary>转写任务 <span class="job-count"></span></summary><ul class="job-list"></ul></details>';
  toolbar.after(container);
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.multiple = true;
  picker.setAttribute('webkitdirectory', '');
  picker.hidden = true;
  picker.setAttribute('aria-label', '选择包含音频和 task.json 的文件夹');
  container.append(picker);
  const dialog = document.createElement('dialog');
  dialog.className = 'import-dialog';
  dialog.setAttribute('aria-labelledby', 'import-dialog-title');
  dialog.innerHTML = '<form><h2 id="import-dialog-title">确认云端转写</h2><p class="import-selection"></p><p>所选音频会发送给豆包（火山引擎），可能包含第三方谈话并产生费用。额度与价格以服务商实际信息为准。</p><p class="retry-warning" hidden>已完成切片会复用缓存；超时或中断的请求可能已被服务商计费，重试可能产生重复费用。</p><label class="import-consent"><input type="checkbox" required />我有权处理这些音频，并同意发送至豆包及潜在费用。</label><div class="import-dialog-actions"><button type="button" class="dialog-cancel"><i data-lucide="x" aria-hidden="true"></i>取消</button><button type="submit"><i data-lucide="upload" aria-hidden="true"></i>确认并开始</button></div></form>';
  document.body.append(dialog);
  let token;
  let folder;
  let retryId;
  let timer;
  let stopped = false;
  let uploading = false;
  let uploadingJobId;
  let polling = false;
  let controller;
  const announced = new Set();
  const errorElement = container.querySelector('.import-error');
  const uploadElement = container.querySelector('.import-upload');
  const showError = (message) => { errorElement.textContent = message; errorElement.hidden = !message; };
  const uploadingText = (message) => { uploadElement.textContent = message; uploadElement.hidden = !message; };
  const labels = { uploading: '等待本地文件', queued: '排队中', validating: '校验音频', transcribing: '豆包转写中', summarizing: '整理原文摘录', importing: '生成播放缓存', completed: '已完成', failed: '失败', interrupted: '已中断', cancelled: '已取消' };

  async function request(path, options = {}) {
    const response = await fetch(`${import.meta.env.BASE_URL}api/import/${path}`, { ...options, headers: { 'X-Limbo-Token': token || '', ...options.headers } });
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('本地任务服务不可用');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '请求失败');
    return result;
  }
  const post = (path, data) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

  function confirm(folderData, job) {
    folder = folderData;
    retryId = job?.id;
    dialog.querySelector('.import-selection').textContent = folderData ? `${folderData.label} / ${folderData.files.size} 个音频` : `任务 ${job.id.slice(-8)} / ${job.total} 个音频`;
    dialog.querySelector('.retry-warning').hidden = !job;
    dialog.querySelector('input[type=checkbox]').checked = false;
    dialog.showModal();
    refreshIcons();
  }

  function action(label, icon, handler) {
    const control = document.createElement('button');
    control.type = 'button';
    control.title = label;
    control.setAttribute('aria-label', label);
    const symbol = document.createElement('i');
    symbol.dataset.lucide = icon;
    symbol.setAttribute('aria-hidden', 'true');
    control.append(symbol, label);
    control.addEventListener('click', () => { Promise.resolve(handler()).catch((error) => showError(error.message)); });
    return control;
  }

  async function render(jobs) {
    const list = container.querySelector('.job-list');
    list.replaceChildren();
    container.querySelector('details').hidden = !jobs.length;
    container.querySelector('.job-count').textContent = String(jobs.length);
    for (const job of [...jobs].reverse()) {
      const row = document.createElement('li');
      row.dataset.job = job.id;
      const heading = document.createElement('div');
      heading.className = 'job-heading';
      const name = document.createElement('strong');
      name.textContent = `${job.id.slice(-8)} / ${labels[job.state] || job.state}`;
      const count = document.createElement('span');
      const complete = job.state === 'uploading' ? job.uploaded.length : job.completed;
      count.textContent = `${complete} / ${job.total}`;
      heading.append(name, count);
      const progress = document.createElement('progress');
      progress.max = job.total;
      progress.value = complete;
      progress.setAttribute('aria-label', '任务进度');
      const controls = document.createElement('div');
      controls.className = 'job-actions';
      row.append(heading, progress);
      if (job.currentFile && !['completed', 'cancelled'].includes(job.state)) { const current = document.createElement('p'); current.className = 'job-file'; current.textContent = job.currentFile; row.append(current); }
      if (job.error) { const error = document.createElement('p'); error.className = 'job-error'; error.textContent = job.error; row.append(error); }
      if (job.state === 'completed') {
        if (!announced.has(job.id)) { await refreshRecordings(); announced.add(job.id); }
        controls.append(action('打开记录', 'arrow-up-right', () => openRecording(job.recordingId)));
      } else if (['failed', 'interrupted'].includes(job.state)) controls.append(action('重试', 'refresh-cw', () => confirm(null, job)));
      else if (job.state === 'uploading') controls.append(action('继续上传', 'folder-plus', () => picker.click()));
      if (!['completed', 'cancelled', 'importing'].includes(job.state)) controls.append(action('取消任务', 'x', async () => {
        if (uploadingJobId === job.id) controller?.abort();
        await post(`jobs/${job.id}/cancel`, {});
        await poll();
      }));
      row.append(controls);
      list.append(row);
    }
    refreshIcons();
  }

  async function poll() {
    if (stopped || polling) return;
    polling = true;
    clearTimeout(timer);
    try { const result = await request('jobs'); await render(result.jobs); }
    catch (error) { showError(error.message); }
    finally { polling = false; if (!stopped) timer = setTimeout(poll, 2500); }
  }

  button.addEventListener('click', () => picker.click());
  picker.addEventListener('change', async () => {
    try { showError(''); confirm(await inspectFolder(picker.files)); }
    catch (error) { showError(error.message); }
    finally { picker.value = ''; }
  });
  dialog.querySelector('.dialog-cancel').addEventListener('click', () => dialog.close());
  dialog.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!dialog.querySelector('input[type=checkbox]').checked || uploading) return;
    dialog.close();
    showError('');
    uploading = true;
    button.disabled = true;
    controller = new AbortController();
    try {
      if (retryId) await post(`jobs/${retryId}/start`, { consent: true });
      else {
        const { task, files } = folder;
        const segments = [];
        let checked = 0;
        for (const segment of task.segments) {
          if (controller.signal.aborted) throw new Error('上传已取消');
          uploadingText(`本地校验 ${++checked} / ${files.size}`);
          const hash = await crypto.subtle.digest('SHA-256', await files.get(segment.file).arrayBuffer());
          const sha256 = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
          if (segment.sha256 !== undefined && segment.sha256 !== sha256) throw new Error(`SHA-256 不匹配：${segment.file}`);
          segments.push({ file: segment.file, offset: segment.offset, duration: segment.duration, sha256 });
        }
        let { job } = await post('jobs', { consent: true, task: { recordingID: task.recordingID, segments, markers: task.markers || [] } });
        uploadingJobId = job.id;
        if (job.state === 'uploading') {
          container.querySelector('details').open = true;
          for (const name of job.files) {
            if (job.uploaded.includes(name)) continue;
            uploadingText(`传至本机 ${job.uploaded.length + 1} / ${job.total}`);
            ({ job } = await request(`jobs/${job.id}/files/${encodeURIComponent(name)}`, { method: 'PUT', body: files.get(name), signal: controller.signal }));
          }
          await post(`jobs/${job.id}/start`, { consent: true });
        } else if (['failed', 'interrupted'].includes(job.state)) await post(`jobs/${job.id}/start`, { consent: true });
      }
      uploadingText('');
      container.querySelector('details').open = true;
    } catch (error) { uploadingText(''); showError(error.name === 'AbortError' ? '本地上传已停止，可重新选择同一文件夹继续。' : error.message); }
    finally { uploading = false; uploadingJobId = null; button.disabled = false; await poll(); }
  });

  request('status').then((status) => { token = status.token; button.disabled = false; return poll(); }).catch(() => { button.title = '本地任务服务未运行'; });
  refreshIcons();
  return () => { stopped = true; clearTimeout(timer); controller?.abort(); dialog.remove(); };
}