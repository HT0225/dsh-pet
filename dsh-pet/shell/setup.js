'use strict';
/** 首次设置窗逻辑：保存桌宠页地址（经 preload 的 petShell.saveUrl → 主进程写 config.json 并启动主窗） */
(() => {
  const input = document.getElementById('url');
  const err = document.getElementById('err');
  const save = document.getElementById('save');

  // 预填到 ?token= 前的部分（服务器地址非敏感）；令牌不进任何仓库文件，由用户粘贴补全
  input.value = 'http://124.221.182.15:3080/pet/?token=';

  const submit = async () => {
    err.textContent = '';
    save.disabled = true;
    try {
      const res = await window.petShell.saveUrl(input.value);
      if (!res.ok) {
        err.textContent = res.error || '保存失败，请检查地址';
        return;
      }
      window.close(); // 地址已保存、主窗已启动：关掉本设置窗
    } finally {
      save.disabled = false;
    }
  };

  save.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submit();
  });
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length); // 光标落在末尾，直接补令牌
})();
