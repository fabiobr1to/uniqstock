(() => {
  const STORAGE_KEY = "prz.sidebarCollapsed";
  const SIDEBAR_SCROLL_KEY = "prz.sidebarNavScrollTop";
  let botaoDesktop = null;

  function isDesktop() {
    return window.innerWidth > 980;
  }

  function getCollapsePreference() {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch (_) {
      return false;
    }
  }

  function setCollapsePreference(collapse) {
    try {
      localStorage.setItem(STORAGE_KEY, collapse ? "1" : "0");
    } catch (_) {}
  }

  function atualizarBotaoDesktop() {
    if (!botaoDesktop) return;
    const colapsado = document.body.classList.contains("sidebar-collapsed");
    botaoDesktop.textContent = colapsado ? "»" : "«";
    botaoDesktop.setAttribute("aria-pressed", colapsado ? "true" : "false");
    botaoDesktop.setAttribute("title", colapsado ? "Expandir menu" : "Recolher menu");
  }

  function atualizarTooltipsSidebar() {
    const habilitar = isDesktop() && document.body.classList.contains("sidebar-collapsed");
    document.querySelectorAll(".sidebar-nav a, .sidebar-footer a").forEach((link) => {
      const label = link.querySelector(".sidebar-link-label");
      const texto = (label?.textContent || "").trim();
      if (!texto) return;
      if (habilitar) {
        link.setAttribute("title", texto);
      } else {
        link.removeAttribute("title");
      }
    });
  }

  function aplicarColapsoDesktop(colapsado, persistir = true) {
    document.body.classList.toggle("sidebar-collapsed", !!colapsado);
    atualizarBotaoDesktop();
    atualizarTooltipsSidebar();
    if (persistir) setCollapsePreference(!!colapsado);
  }

  function prepararLabelsSidebar() {
    document.querySelectorAll(".sidebar-nav a, .sidebar-footer a").forEach((link) => {
      if (link.querySelector(".sidebar-link-label")) return;

      const textos = Array.from(link.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || "")
        .join(" ")
        .trim();

      Array.from(link.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .forEach((node) => node.remove());

      const label = document.createElement("span");
      label.className = "sidebar-link-label";
      label.textContent = textos;
      link.appendChild(label);
    });
  }

  function fecharMenu() {
    document.body.classList.remove("sidebar-open");
    const btn = document.querySelector(".mobile-menu-btn");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

  async function limparDadosLocais() {
    try {
      localStorage.clear();
    } catch (_) {}

    try {
      sessionStorage.clear();
    } catch (_) {}

    if ("caches" in window) {
      try {
        const nomes = await caches.keys();
        await Promise.all(nomes.map((nome) => caches.delete(nome)));
      } catch (_) {}
    }
  }

  async function sairComLimpeza() {
    try {
      await fetch("/api/logout", {
        method: "POST",
        credentials: "same-origin"
      });
    } catch (_) {}

    await limparDadosLocais();
    window.location.href = "/login.html?logout=1";
  }

  function alternarMenu() {
    const aberto = document.body.classList.toggle("sidebar-open");
    const btn = document.querySelector(".mobile-menu-btn");
    if (btn) btn.setAttribute("aria-expanded", aberto ? "true" : "false");
  }

  document.addEventListener("DOMContentLoaded", () => {
    const sidebar = document.querySelector(".sidebar");
    if (!sidebar) return;
    prepararLabelsSidebar();
    const sidebarNav = document.querySelector(".sidebar-nav");

    if (sidebarNav) {
      try {
        const salvo = Number(sessionStorage.getItem(SIDEBAR_SCROLL_KEY) || "0");
        if (Number.isFinite(salvo) && salvo > 0) {
          sidebarNav.scrollTop = salvo;
        }
      } catch (_) {}

      const salvarScrollSidebar = () => {
        try {
          sessionStorage.setItem(SIDEBAR_SCROLL_KEY, String(sidebarNav.scrollTop || 0));
        } catch (_) {}
      };

      sidebarNav.addEventListener("scroll", salvarScrollSidebar, { passive: true });
      window.addEventListener("beforeunload", salvarScrollSidebar);
    }

    botaoDesktop = document.createElement("button");
    botaoDesktop.type = "button";
    botaoDesktop.className = "sidebar-collapse-btn";
    botaoDesktop.setAttribute("aria-label", "Alternar menu lateral");
    sidebar.appendChild(botaoDesktop);
    botaoDesktop.addEventListener("click", () => {
      if (!isDesktop()) return;
      const proximo = !document.body.classList.contains("sidebar-collapsed");
      aplicarColapsoDesktop(proximo, true);
    });

    if (isDesktop() && getCollapsePreference()) {
      aplicarColapsoDesktop(true, false);
    } else {
      aplicarColapsoDesktop(false, false);
    }

    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "mobile-menu-btn";
    botao.setAttribute("aria-label", "Abrir menu");
    botao.setAttribute("aria-expanded", "false");
    botao.innerHTML = '<span></span><span></span><span></span>';

    const overlay = document.createElement("div");
    overlay.className = "sidebar-overlay";

    document.body.appendChild(botao);
    document.body.appendChild(overlay);

    botao.addEventListener("click", alternarMenu);
    overlay.addEventListener("click", fecharMenu);

    document.querySelectorAll(".sidebar-nav a, .sidebar-footer a").forEach((link) => {
      link.addEventListener("click", () => {
        if (sidebarNav) {
          try {
            sessionStorage.setItem(SIDEBAR_SCROLL_KEY, String(sidebarNav.scrollTop || 0));
          } catch (_) {}
        }
        if (window.innerWidth <= 980) fecharMenu();
      });
    });

    const linkSair = document.querySelector('.sidebar-footer a[href="login.html"], .sidebar-footer a[href="/login.html"]');
    if (linkSair) {
      linkSair.title = "Sair e limpar dados locais";
      linkSair.addEventListener("click", async (e) => {
        e.preventDefault();
        const confirmar = window.confirm("Deseja sair e limpar os dados locais deste navegador?");
        if (!confirmar) return;
        await sairComLimpeza();
      });
    }

    window.addEventListener("resize", () => {
      if (isDesktop()) {
        fecharMenu();
        aplicarColapsoDesktop(getCollapsePreference(), false);
      } else {
        document.body.classList.remove("sidebar-collapsed");
        atualizarTooltipsSidebar();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") fecharMenu();
    });
  });
})();
