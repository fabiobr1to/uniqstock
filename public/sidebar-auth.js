(() => {
  const permissionByPage = {
    "dashboard.html": "ver_dashboard",
    "index.html": "ver_inventario",
    "cadastro-ferramenta.html": "criar_itens",
    "etiquetas.html": "ver_etiquetas",
    "scanner.html": "usar_scanner",
    "movimentacoes.html": "ver_movimentacoes",
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

  function setMenuVisibility(permissoes) {
    const links = document.querySelectorAll(".sidebar-nav a[href]");
    let currentHidden = false;

    links.forEach((link) => {
      const page = getPageName(link.getAttribute("href"));
      const perm = permissionByPage[page];
      if (!perm) return;

      const allowed = Number(permissoes?.[perm]) === 1;
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
