const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function money(n){ return (Number(n)||0).toFixed(2).replace(".", ","); }

async function api(url, method="GET", body){
  const res = await fetch(url, {
    method,
    headers: body ? {"Content-Type":"application/json"} : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if(!res.ok) throw new Error(data.error || "Erro");
  return data;
}

// Tabs
$$(".tab").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    $$(".tab").forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");
    $$(".panel").forEach(p=>p.classList.remove("show"));
    $("#"+btn.dataset.tab).classList.add("show");
  });
});

async function loadItems(){
  const items = await api("/api/items");
  const tbody = $("#tableItems tbody");
  tbody.innerHTML = "";

  const sel = $("#formMov select[name=item_id]");
  sel.innerHTML = `<option value="">Selecione um item...</option>`;

  items.forEach(it=>{
    const low = Number(it.estoque_atual) < Number(it.estoque_min || 0);
    const tr = document.createElement("tr");
    if(low) tr.classList.add("low");

    tr.innerHTML = `
      <td>${it.codigo || ""}</td>
      <td>${it.nome}</td>
      <td>${it.categoria || ""}</td>
      <td>${it.unidade || ""}</td>
      <td>${money(it.estoque_atual)}</td>
      <td>${money(it.estoque_min)}</td>
      <td>${it.localizacao || ""}</td>
      <td>${low ? `<span class="badge low">ABAIXO</span>` : `<span class="badge ok">OK</span>`}</td>
    `;
    tbody.appendChild(tr);

    sel.innerHTML += `<option value="${it.id}">${it.codigo ? it.codigo+" — " : ""}${it.nome}</option>`;
  });
}

async function loadMovements(){
  const movs = await api("/api/movements");
  const tbody = $("#tableMov tbody");
  tbody.innerHTML = "";
  movs.forEach(m=>{
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${m.data}</td>
      <td>${m.codigo || ""}</td>
      <td>${m.nome || ""}</td>
      <td>${m.tipo}</td>
      <td>${money(m.quantidade)}</td>
      <td>${m.obra || ""}</td>
      <td>${m.funcionario || ""}</td>
      <td>${m.observacao || ""}</td>
    `;
    tbody.appendChild(tr);
  });
}

// Form item
$("#formItem").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  body.estoque_min = Number(body.estoque_min || 0);

  try{
    await api("/api/items", "POST", body);
    e.target.reset();
    await loadItems();
    alert("Item salvo!");
  }catch(err){
    alert(err.message);
  }
});

// Form mov
$("#formMov").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  body.item_id = Number(body.item_id);
  body.quantidade = Number(body.quantidade);

  try{
    await api("/api/movements", "POST", body);
    e.target.reset();
    await loadItems();
    await loadMovements();
    alert("Movimentação registrada!");
  }catch(err){
    alert(err.message);
  }
});

// init
(async ()=>{
  await loadItems();
  await loadMovements();
})();