(() => {
  function garantirBlocoCabecalho(header) {
    const blocoExistente = header.querySelector(":scope > .inventory-header-copy, :scope > .page-header-copy");
    if (blocoExistente) return blocoExistente;

    const copy = document.createElement("div");
    copy.className = "page-header-copy";

    const filhosOriginais = Array.from(header.children);
    filhosOriginais.forEach((filho) => {
      if (filho.classList.contains("page-user-meta")) return;
      copy.appendChild(filho);
    });

    header.prepend(copy);
    return copy;
  }

  function formatarDataHoraAgora() {
    const agora = new Date();
    const data = agora.toLocaleDateString("pt-BR");
    const hora = agora.toLocaleTimeString("pt-BR", { hour12: false });
    return `${data} ${hora}`;
  }

  async function carregarUsuario() {
    const res = await fetch("/api/me", { credentials: "same-origin" });
    const data = await res.json();
    if (!res.ok || !data?.user) throw new Error(data?.error || "Erro");
    return data.user;
  }

  async function carregarStatusLicenca() {
    const res = await fetch("/api/licenca/status", { credentials: "same-origin" });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Erro ao consultar licença");
    return data;
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const header = document.querySelector(".page-header");
    if (!header) return;
    garantirBlocoCabecalho(header);

    try {
      const [user, licenca] = await Promise.all([
        carregarUsuario(),
        carregarStatusLicenca().catch(() => null)
      ]);
      const info = document.createElement("div");
      info.className = "page-user-meta";

      if (licenca?.ativa) {
        const licencaAtiva = document.createElement("p");
        licencaAtiva.className = "page-license-status";
        licencaAtiva.textContent = "Licença ativa";
        info.appendChild(licencaAtiva);
      }

      const nome = document.createElement("p");
      nome.className = "page-user-name";
      nome.textContent = `Usuário: ${user.usuario} (${user.perfil})`;

      const dataHora = document.createElement("p");
      dataHora.className = "page-user-datetime";
      dataHora.textContent = formatarDataHoraAgora();

      info.appendChild(nome);
      info.appendChild(dataHora);
      header.appendChild(info);

      setInterval(() => {
        dataHora.textContent = formatarDataHoraAgora();
      }, 1000);
    } catch (_) {
      // Sidebar/auth script já trata redirecionamento quando necessário.
    }
  });
})();
