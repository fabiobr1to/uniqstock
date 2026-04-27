(() => {
  const permissionByPage = {
    "dashboard.html": "ver_dashboard",
    "index.html": "ver_inventario",
    "ferramentaria.html": "registrar_movimentacao",
    "almoxarifado.html": "ver_inventario",
    "balcao-almoxarifado.html": "registrar_movimentacao",
    "cadastro-almoxarifado.html": "criar_itens",
    "cadastro-ferramenta.html": "criar_itens",
    "etiquetas.html": "ver_etiquetas",
    "scanner.html": "usar_scanner",
    "movimentacoes.html": "ver_movimentacoes",
    "movimentacoes-ferramentaria.html": "ver_movimentacoes",
    "movimentacoes-almoxarifado.html": "ver_movimentacoes",
    "usuarios.html": "gerenciar_usuarios",
    "permissoes.html": "gerenciar_usuarios",
    "auditoria.html": "gerenciar_usuarios",
    "configuracoes.html": "gerenciar_usuarios"
  };

  async function getJson(url) {
    const res = await fetch(url, { credentials: "same-origin" });
    let data = {};
    try {
      data = await res.json();
    } catch (_) {}
    if (!res.ok) {
      const err = new Error(data.error || "Erro");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function getPageName(href) {
    const value = String(href || "").split("?")[0].split("#")[0];
    const parts = value.split("/");
    return parts[parts.length - 1];
  }

  function hasPermission(permissoes, perm) {
    const valorAtual = permissoes?.[perm];
    if (valorAtual !== undefined && valorAtual !== null) {
      return Number(valorAtual) === 1;
    }

    if (perm === "criar_itens" || perm === "editar_itens" || perm === "excluir_itens") {
      return Number(permissoes?.criar_editar_itens) === 1;
    }

    return false;
  }

  function setMenuVisibility(permissoes) {
    const links = document.querySelectorAll(".sidebar-nav a[href]");
    let currentHidden = false;

    links.forEach((link) => {
      const page = getPageName(link.getAttribute("href"));
      const perm = permissionByPage[page];
      if (!perm) return;

      const allowed = hasPermission(permissoes, perm);
      if (!allowed) {
        if (link.classList.contains("ativo")) currentHidden = true;
        link.style.display = "none";
      }
    });

    if (currentHidden) {
      window.location.href = "/acesso-negado.html";
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    if (!document.querySelector(".sidebar-nav")) return;
    try {
      const me = await getJson("/api/me");
      if (me?.user?.perfil === "admin") return;

      const dadosPerms = await getJson("/api/minhas-permissoes");
      setMenuVisibility(dadosPerms.permissoes || {});
    } catch (e) {
      if (e?.status === 403) {
        window.location.href = "/acesso-negado.html";
      } else {
        window.location.href = "/login.html";
      }
    }
  });
})();
