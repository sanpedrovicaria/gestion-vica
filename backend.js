/* ==========================================================================
   backend.js — Interruptor entre Google Sheets (Apps Script) y Supabase

   Las páginas piden todo con:  Backend.llamar(modulo, { accion: '...', ... })
   y reciben el mismo formato que devolvía Apps Script: { success, data, message }.
   Así el resto del código de las pantallas no cambia según el modo.

   Para quitar el interruptor cuando termine la migración:
     MODO_POR_DEFECTO: 'supabase'   y   PERMITIR_SWITCH: false
   ========================================================================== */
(function () {

  // ========================== CONFIGURACIÓN ==========================
  const CONFIG = {
    MODO_POR_DEFECTO: 'sheets',   // 'sheets' o 'supabase'
    PERMITIR_SWITCH: true,        // true = se ve el interruptor en el login

    SUPABASE_URL: 'https://oajjqfgqbxyquzjunflk.supabase.co',
    SUPABASE_KEY: 'sb_publishable_SOsHD-fWe3kG70fE3SdvSg_c5FxEOY0',   // clave publicable (pública por diseño)

    API_SHEETS: {
      bautismo: 'https://script.google.com/macros/s/AKfycbyiFao36Cgrfe7IHyevzx81euc_yK17-6BAjxIP1XJ7cIEZ0U_3lcM4Zfx2xB9aPqNrUA/exec',
      confirmacion: 'https://script.google.com/macros/s/AKfycbyLw_K3TYBvsSPrlQFG2HdH9pJWgcO9zmSNggyPOjvNvh2Jb_izrCZ3DzXgTvFFBv1C/exec'
    }
  };

  const CLAVE_MODO = 'backendParroquia';

  const TABLAS = { bautismo: 'bautismos', confirmacion: 'confirmaciones' };
  const CAMPO_FECHA = { bautismo: 'fecha_bautizo', confirmacion: 'fecha_confirmacion' };
  const TIPO_HISTORIAL = { bautismo: 'BAUTISMO', confirmacion: 'CONFIRMACION' };


  // ========================== MODO ==========================
  function modoActual() {
    if (!CONFIG.PERMITIR_SWITCH) return CONFIG.MODO_POR_DEFECTO;
    const guardado = localStorage.getItem(CLAVE_MODO);
    if (guardado === 'sheets' || guardado === 'supabase') return guardado;
    return CONFIG.MODO_POR_DEFECTO;
  }

  function cambiarModo(modo) {
    if (modo === 'sheets' || modo === 'supabase') localStorage.setItem(CLAVE_MODO, modo);
  }

  function nombreModo() {
    return modoActual() === 'sheets' ? 'Google Sheets' : 'Supabase';
  }


  // ========================== CLIENTE SUPABASE ==========================
  // Se crea solo cuando se necesita, así en modo Sheets no depende de la librería
  let clienteSB = null;

  function sb() {
    if (!clienteSB) {
      if (!window.supabase) throw new Error('No se pudo cargar la librería de Supabase.');
      clienteSB = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
    }
    return clienteSB;
  }

  // Devuelve los datos de una respuesta de Supabase o lanza el error con un mensaje claro
  function revisar(respuesta) {
    if (respuesta.error) {
      if (respuesta.error.code === '42501') throw new Error('No tienes permiso para hacer esta acción.');
      throw new Error(respuesta.error.message);
    }
    return respuesta.data;
  }

  async function usuarioSB() {
    const r = await sb().auth.getSession();
    if (!r.data.session) throw new Error('La sesión venció. Vuelve a iniciar sesión.');
    return r.data.session.user;
  }

  async function leerPerfil(idUsuario) {
    const r = await sb().from('perfiles').select('nombre_completo, rol, activo').eq('id', idUsuario).maybeSingle();
    return r.data;
  }

  function guardarDatosUsuario(usuario, perfil) {
    const nombre = (perfil && perfil.nombre_completo) ? perfil.nombre_completo : usuario.email;
    localStorage.setItem('usuarioParroquia', nombre);
    localStorage.setItem('rolParroquia', perfil ? perfil.rol : '');
  }


  // ========================== AYUDAS DE FORMATO ==========================
  function texto(valor) {
    return (valor === null || valor === undefined) ? '' : valor;
  }

  function mayus(valor) {
    return texto(valor).toString().toUpperCase();
  }

  function vacioANull(valor) {
    return (valor && valor.toString().trim() !== '') ? valor : null;
  }

  // "2026-04-03" -> "03/04/2026"
  function isoADMY(iso) {
    if (!iso) return '';
    const partes = iso.toString().substring(0, 10).split('-');
    if (partes.length !== 3) return iso;
    return partes[2] + '/' + partes[1] + '/' + partes[0];
  }

  // "3/4/2026" o "03/04/2026" -> "2026-04-03". Vacío o "-" -> null. Si no se entiende, lanza error.
  function dmyAISO(valor) {
    const t = texto(valor).toString().trim();
    if (t === '' || t === '-' || t === '—') return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;

    const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) throw new Error('Fecha no válida: "' + t + '". Usa el formato dd/mm/aaaa.');

    const dia = Number(m[1]);
    const mes = Number(m[2]);
    const anio = Number(m[3]);
    const f = new Date(anio, mes - 1, dia);
    if (f.getFullYear() !== anio || f.getMonth() !== mes - 1 || f.getDate() !== dia) {
      throw new Error('La fecha "' + t + '" no existe.');
    }
    return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  }

  // Fecha y hora de Tacna: "03/04/2026 08:44:18"
  function fechaHoraLocal(marcaDeTiempo) {
    if (!marcaDeTiempo) return '-';
    return new Date(marcaDeTiempo)
      .toLocaleString('en-GB', { timeZone: 'America/Lima', hourCycle: 'h23' })
      .replace(',', '');
  }


  // ========================== MODO SHEETS (Apps Script) ==========================
  // Igual que antes: POST con el JSON como texto, sin cabeceras (así no hay preflight de CORS)
  async function llamarSheets(modulo, payload) {
    const respuesta = await fetch(CONFIG.API_SHEETS[modulo], { method: 'POST', body: JSON.stringify(payload) });
    return await respuesta.json();
  }


  // ========================== MODO SUPABASE: partidas ==========================
  // Convierten una fila de Supabase al formato que ya esperan las pantallas (el mismo de Apps Script)
  function filaBautismo(r) {
    return {
      id: r.codigo_partida,
      nro_libro: texto(r.nro_libro), foja: texto(r.foja), numero: texto(r.numero),
      nombres: texto(r.nombres), apellidos: texto(r.apellidos), nombre_completo: texto(r.nombre_completo),
      fecha_bautizo: isoADMY(r.fecha_bautizo), fecha_bautizo_escrito: texto(r.fecha_bautizo_escrito),
      lugar_bautizo: texto(r.lugar_bautizo), ministro: texto(r.ministro),
      lugar_nacimiento: texto(r.lugar_nacimiento), fecha_nacimiento: isoADMY(r.fecha_nacimiento),
      fecha_nac_escrito: texto(r.fecha_nacimiento_escrito),
      padre: texto(r.padre), madre: texto(r.madre), padrino: texto(r.padrino), madrina: texto(r.madrina),
      nota_marginal: texto(r.nota_marginal), anotaciones: texto(r.anotaciones),
      estado: texto(r.estado)
    };
  }

  function filaConfirmacion(r) {
    return {
      id: r.codigo_partida,
      nro_libro: texto(r.nro_libro), foja: texto(r.foja), numero: texto(r.numero),
      nombres: texto(r.nombres), apellidos: texto(r.apellidos), nombre_completo: texto(r.nombre_completo),
      fecha_confirmacion: isoADMY(r.fecha_confirmacion),
      fecha_confirmacion_escrita: texto(r.fecha_confirmacion_escrito),
      fecha_bautizo: isoADMY(r.fecha_confirmacion),   // igual que Apps Script: la tabla lo lee de aquí
      lugar_confirmacion: texto(r.lugar_confirmacion), ministro: texto(r.ministro),
      lugar_nacimiento: texto(r.lugar_nacimiento), fecha_nacimiento: isoADMY(r.fecha_nacimiento),
      fecha_nac_escrito: texto(r.fecha_nacimiento_escrito),
      lugar_bautismo: texto(r.lugar_bautismo),
      fecha_bau_original: isoADMY(r.fecha_bautismo),
      fecha_bau_escrito_original: texto(r.fecha_bautismo_escrito),
      padre: texto(r.padre), madre: texto(r.madre), padrino: texto(r.padrino), madrina: texto(r.madrina),
      nota_marginal: texto(r.nota_marginal), anotaciones: texto(r.anotaciones),
      catequesis: texto(r.tipo_catequesis),
      fechamodificada: fechaHoraLocal(r.updated_at),
      estado: texto(r.estado)
    };
  }

  async function sbBuscar(modulo, p) {
    let consulta = sb().from(TABLAS[modulo]).select('*');

    // Cada palabra debe aparecer en el código, el nombre, el padre o la madre
    const palabras = texto(p.termino).trim().split(/\s+/).filter(x => x !== '');
    palabras.forEach(function (palabra) {
      const limpia = palabra.replace(/[%,()*]/g, '');
      if (limpia === '') return;
      consulta = consulta.or(
        'codigo_partida.ilike.*' + limpia + '*,nombre_completo.ilike.*' + limpia + '*,padre.ilike.*' + limpia + '*,madre.ilike.*' + limpia + '*'
      );
    });

    const anio = texto(p.anio).toString().trim();
    if (/^\d{4}$/.test(anio)) {
      consulta = consulta.gte(CAMPO_FECHA[modulo], anio + '-01-01').lte(CAMPO_FECHA[modulo], anio + '-12-31');
    }

    // Un libro se identifica igual que la pestaña del Sheets: LIBRO_B54, LIBROCONF1...
    const libro = quitarPrefijoLibro(modulo, p.libro);
    if (libro !== '') consulta = consulta.eq('nro_libro', libro);

    // "Cargar más": se piden limite + 1 filas para saber si todavía quedan registros
    const limite = Math.max(1, parseInt(p.limite, 10) || 30);
    const desde = Math.max(0, parseInt(p.desde, 10) || 0);
    const filas = revisar(await consulta.order('id', { ascending: true }).range(desde, desde + limite));
    const convertir = (modulo === 'bautismo') ? filaBautismo : filaConfirmacion;
    return { success: true, data: filas.slice(0, limite).map(convertir), hay_mas: filas.length > limite };
  }

  const PREFIJO_LIBRO = { bautismo: 'LIBRO_B', confirmacion: 'LIBROCONF' };

  function quitarPrefijoLibro(modulo, hoja) {
    const nombre = texto(hoja).trim();
    const prefijo = PREFIJO_LIBRO[modulo];
    return nombre.toUpperCase().startsWith(prefijo) ? nombre.slice(prefijo.length) : nombre;
  }

  // Lista de libros con su conteo (usa la función listar_libros de Supabase, ver README)
  async function sbListarLibros(modulo) {
    const filas = revisar(await sb().rpc('listar_libros', { p_tabla: TABLAS[modulo] }));
    const libros = filas
      .filter(f => texto(f.nro_libro).trim() !== '')
      .map(f => ({ hoja: PREFIJO_LIBRO[modulo] + f.nro_libro, total: Number(f.total) }));
    return { success: true, data: libros };
  }

  async function sbEditar(modulo, p) {
    const d = p.datos;
    let cambios;

    if (modulo === 'bautismo') {
      cambios = {
        nro_libro: d.nro_libro, foja: d.foja, numero: d.numero,
        nombres: d.nombres, apellidos: d.apellidos,
        fecha_bautizo: dmyAISO(d.fecha_bautizo), fecha_bautizo_escrito: d.fecha_bautizo_escrito,
        lugar_bautizo: d.lugar_bautizo, ministro: d.ministro,
        lugar_nacimiento: d.lugar_nacimiento, fecha_nacimiento: dmyAISO(d.fecha_nacimiento),
        fecha_nacimiento_escrito: d.fecha_nac_escrito,
        padre: d.padre, madre: d.madre, padrino: d.padrino, madrina: d.madrina,
        nota_marginal: d.nota_marginal, anotaciones: d.anotaciones
      };
    } else {
      cambios = {
        nro_libro: d.nro_libro, foja: d.foja, numero: d.numero,
        nombres: d.nombres, apellidos: d.apellidos,
        fecha_confirmacion: dmyAISO(d.fecha_confirmacion), fecha_confirmacion_escrito: d.fecha_confirmacion_escrita,
        lugar_confirmacion: d.lugar_confirmacion, ministro: d.ministro,
        lugar_nacimiento: d.lugar_nacimiento, fecha_nacimiento: dmyAISO(d.fecha_nacimiento),
        fecha_nacimiento_escrito: d.fecha_nac_escrito,
        lugar_bautismo: d.lugar_bautismo, fecha_bautismo: dmyAISO(d.fecha_bautizo),
        fecha_bautismo_escrito: d.fecha_bautizo_escrito,
        padre: d.padre, madre: d.madre, padrino: d.padrino, madrina: d.madrina,
        nota_marginal: d.nota_marginal, anotaciones: d.anotaciones
      };
    }

    const usuario = await usuarioSB();
    cambios.modificado_por = usuario.id;

    // .select() devuelve las filas tocadas; si no hay ninguna, no existe o no hay permiso (RLS no avisa con error)
    const filas = revisar(await sb().from(TABLAS[modulo]).update(cambios).eq('codigo_partida', d.id).select('id'));
    if (filas.length === 0) return { success: false, message: 'No se encontró el registro o no tienes permiso para editarlo.' };
    return { success: true, message: 'Registro actualizado.' };
  }

  // El PDF se sigue generando con Apps Script (la plantilla vive en la hoja PartidaPlantilla).
  // En modo Supabase además se anota la emisión en la tabla historial_emisiones.
  async function sbGenerarPartida(modulo, p) {
    const usuario = await usuarioSB();
    const perfil = await leerPerfil(usuario.id);
    if (!perfil || (perfil.rol !== 'admin' && perfil.rol !== 'secretaria')) {
      return { success: false, message: 'Tu rol no permite generar partidas.' };
    }

    const respuesta = await llamarSheets(modulo, p);
    if (!respuesta.success) return respuesta;

    const d = p.datos;
    const registro = await sb().from('historial_emisiones').insert({
      tipo_sacramento: TIPO_HISTORIAL[modulo],
      codigo_partida: d.id,
      nombres_completos: (texto(d.nombres) + ' ' + texto(d.apellidos)).trim(),
      usuario_id: usuario.id,
      usuario_texto: texto(p.usuario),
      enlace_pdf: respuesta.pdfUrl
    });
    if (registro.error) {
      respuesta.advertencia = 'El PDF se generó, pero no se pudo anotar en el historial de Supabase: ' + registro.error.message;
    }
    return respuesta;
  }

  async function sbHistorial(modulo) {
    const filas = revisar(
      await sb().from('historial_emisiones').select('*')
        .eq('tipo_sacramento', TIPO_HISTORIAL[modulo])
        .order('created_at', { ascending: false })
        .limit(100)
    );
    const data = filas.map(function (h) {
      return {
        fechaHora: fechaHoraLocal(h.created_at),
        idPartida: h.codigo_partida || '-',
        nombreCompleto: h.nombres_completos || '-',
        usuario: h.usuario_texto || '-',
        link: h.enlace_pdf || '#'
      };
    });
    return { success: true, data: data };
  }


  // ========================== MODO SUPABASE: sacerdotes ==========================
  async function sbObtenerSacerdotes() {
    const filas = revisar(await sb().from('sacerdotes').select('nombre, estado').order('id', { ascending: true }));
    return { success: true, data: filas.map(s => [s.nombre, s.estado]) };
  }

  async function sbAgregarSacerdote(modulo, p) {
    revisar(await sb().from('sacerdotes').insert({ nombre: mayus(p.nombre), estado: 'INACTIVO' }));
    return { success: true };
  }

  async function sbActivarSacerdote(modulo, p) {
    // Primero se activa el elegido y después se desactivan los demás,
    // así nunca queda la lista sin sacerdote activo si algo falla a la mitad
    const activado = revisar(await sb().from('sacerdotes').update({ estado: 'ACTIVO' }).eq('nombre', p.nombre).select('id'));
    if (activado.length === 0) return { success: false, message: 'No tienes permiso para cambiar el sacerdote activo.' };
    revisar(await sb().from('sacerdotes').update({ estado: 'INACTIVO' }).neq('nombre', p.nombre));
    return { success: true };
  }


  // ========================== MODO SUPABASE: candidatos ==========================
  function filaCandidato(c) {
    return {
      id: c.codigo,
      nombre_bautizado: texto(c.nombre_bautizado), hora: texto(c.hora), dia_bautismo: texto(c.dia_bautismo),
      fecha_bautismo_prog: texto(c.fecha_bautismo_prog), ministro: texto(c.ministro),
      lugar_nacimiento: texto(c.lugar_nacimiento), fecha_nacimiento: texto(c.fecha_nacimiento),
      padre: texto(c.padre), lugar_nac_padre: texto(c.lugar_nac_padre),
      madre: texto(c.madre), lugar_nac_madre: texto(c.lugar_nac_madre),
      padrino: texto(c.padrino), madrina: texto(c.madrina),
      direccion: texto(c.direccion), celular: texto(c.celular),
      fecha_registro: fechaHoraLocal(c.created_at),
      estado: texto(c.estado)
    };
  }

  // Los textos van en mayúsculas, igual que hacía Apps Script
  function camposCandidato(d) {
    return {
      nombre_bautizado: mayus(d.nombre_bautizado),
      hora: texto(d.hora),
      dia_bautismo: mayus(d.dia_bautismo),
      fecha_bautismo_prog: vacioANull(d.fecha_bautismo_prog),
      ministro: mayus(d.ministro),
      lugar_nacimiento: mayus(d.lugar_nacimiento),
      fecha_nacimiento: vacioANull(d.fecha_nacimiento),
      padre: mayus(d.padre), lugar_nac_padre: mayus(d.lugar_nac_padre),
      madre: mayus(d.madre), lugar_nac_madre: mayus(d.lugar_nac_madre),
      padrino: mayus(d.padrino), madrina: mayus(d.madrina),
      direccion: mayus(d.direccion),
      celular: texto(d.celular)
    };
  }

  async function sbBuscarCandidatos(modulo, p) {
    let consulta = sb().from('candidatos_bautismo').select('*');

    const palabras = texto(p.termino).trim().split(/\s+/).filter(x => x !== '');
    palabras.forEach(function (palabra) {
      const limpia = palabra.replace(/[%,()*]/g, '');
      if (limpia === '') return;
      consulta = consulta.or('nombre_bautizado.ilike.*' + limpia + '*,padre.ilike.*' + limpia + '*,madre.ilike.*' + limpia + '*');
    });

    const filas = revisar(await consulta.order('id', { ascending: false }).limit(500));
    return { success: true, data: filas.map(filaCandidato) };
  }

  async function sbRegistrarCandidato(modulo, p) {
    const d = p.datos;
    if (!d || !d.nombre_bautizado || d.nombre_bautizado.toString().trim() === '') {
      return { success: false, message: 'El nombre del bautizado es obligatorio.' };
    }

    const usuario = await usuarioSB();
    const nuevo = camposCandidato(d);
    nuevo.creado_por = usuario.id;

    const filas = revisar(await sb().from('candidatos_bautismo').insert(nuevo).select('id'));
    const id = filas[0].id;

    // El código legible (C2026-0004) se arma con el número que asignó la base de datos
    const codigo = 'C' + new Date().getFullYear() + '-' + String(id).padStart(4, '0');
    revisar(await sb().from('candidatos_bautismo').update({ codigo: codigo }).eq('id', id));

    return { success: true, id: codigo, message: 'Candidato registrado correctamente.' };
  }

  async function sbEditarCandidato(modulo, p) {
    const d = p.datos;
    const filas = revisar(await sb().from('candidatos_bautismo').update(camposCandidato(d)).eq('codigo', d.id).select('id'));
    if (filas.length === 0) return { success: false, message: 'No se encontró el candidato.' };
    return { success: true, message: 'Candidato actualizado.' };
  }

  async function sbEliminarCandidato(modulo, p) {
    const encontrados = revisar(await sb().from('candidatos_bautismo').select('id, estado').eq('codigo', p.id));
    if (encontrados.length === 0) return { success: false, message: 'No se encontró el candidato.' };
    if (encontrados[0].estado === 'IMPRESO') {
      return { success: false, message: 'No se puede eliminar: este candidato ya fue impreso.' };
    }

    const borrados = revisar(await sb().from('candidatos_bautismo').delete().eq('id', encontrados[0].id).select('id'));
    if (borrados.length === 0) return { success: false, message: 'No tienes permiso para eliminar candidatos.' };
    return { success: true };
  }

  async function sbMarcarImpresoCandidatos(modulo, p) {
    if (!p.ids || p.ids.length === 0) return { success: false, message: 'Sin IDs.' };
    revisar(await sb().from('candidatos_bautismo').update({ estado: 'IMPRESO' }).in('codigo', p.ids));
    return { success: true };
  }


  // ========================== MODO SUPABASE: despachador ==========================
  const ACCIONES_SUPABASE = {
    buscar: sbBuscar,
    listar_libros: sbListarLibros,
    editar: sbEditar,
    generar_partida: sbGenerarPartida,
    obtener_historial: sbHistorial,
    obtener_sacerdotes: sbObtenerSacerdotes,
    agregar_sacerdote: sbAgregarSacerdote,
    activar_sacerdote: sbActivarSacerdote,
    buscar_candidatos: sbBuscarCandidatos,
    registrar_candidato: sbRegistrarCandidato,
    editar_candidato: sbEditarCandidato,
    eliminar_candidato: sbEliminarCandidato,
    marcar_impreso_candidatos: sbMarcarImpresoCandidatos
  };

  async function llamarSupabase(modulo, payload) {
    const accion = ACCIONES_SUPABASE[payload.accion];
    if (!accion) return { success: false, message: 'Acción no disponible en Supabase: ' + payload.accion };
    try {
      return await accion(modulo, payload);
    } catch (e) {
      return { success: false, message: e.message };
    }
  }


  // ========================== API PÚBLICA ==========================
  // modulo: 'bautismo' o 'confirmacion' (en sacerdotes y candidatos se usa siempre 'bautismo')
  async function llamar(modulo, payload) {
    if (modoActual() === 'sheets') return await llamarSheets(modulo, payload);
    return await llamarSupabase(modulo, payload);
  }

  async function login(usuario, password) {
    try {
      if (modoActual() === 'sheets') {
        const r = await llamarSheets('bautismo', { accion: 'login', usuario: usuario, password: password });
        if (!r.success) return { success: false, message: 'Usuario o contraseña incorrectos.' };
        localStorage.setItem('sesionParroquia', 'activa');
        localStorage.setItem('usuarioParroquia', usuario);
        return { success: true };
      }

      const r = await sb().auth.signInWithPassword({ email: usuario, password: password });
      if (r.error) {
        const mensaje = (r.error.message === 'Invalid login credentials') ? 'Correo o contraseña incorrectos.' : r.error.message;
        return { success: false, message: mensaje };
      }
      const perfil = await leerPerfil(r.data.user.id);
      if (perfil && perfil.activo === false) {
        await sb().auth.signOut();
        return { success: false, message: 'Tu cuenta está inactiva.' };
      }
      guardarDatosUsuario(r.data.user, perfil);
      return { success: true };

    } catch (e) {
      return { success: false, message: 'No se pudo conectar: ' + e.message };
    }
  }

  // Devuelve { usuario } si hay sesión en el modo actual, o null
  async function leerSesion() {
    try {
      if (modoActual() === 'sheets') {
        if (localStorage.getItem('sesionParroquia') !== 'activa') return null;
        return { usuario: localStorage.getItem('usuarioParroquia') || 'ADMIN' };
      }

      const r = await sb().auth.getSession();
      const sesion = r.data.session;
      if (!sesion) return null;
      const perfil = await leerPerfil(sesion.user.id);
      if (perfil && perfil.activo === false) return null;
      guardarDatosUsuario(sesion.user, perfil);
      return { usuario: localStorage.getItem('usuarioParroquia') };

    } catch (e) {
      return null;
    }
  }

  // Para las páginas internas: si no hay sesión, manda al login
  async function requerirSesion() {
    const sesion = await leerSesion();
    if (!sesion) {
      location.href = 'index.html';
      return null;
    }
    return sesion.usuario;
  }

  async function cerrarSesion() {
    if (modoActual() === 'supabase') {
      try { await sb().auth.signOut(); } catch (e) { console.error(e); }
    }
    ['sesionParroquia', 'usuarioParroquia', 'rolParroquia'].forEach(k => localStorage.removeItem(k));
    location.href = 'index.html';
  }

  window.Backend = {
    modo: modoActual,
    nombreModo: nombreModo,
    cambiarModo: cambiarModo,
    permiteSwitch: CONFIG.PERMITIR_SWITCH,
    login: login,
    leerSesion: leerSesion,
    requerirSesion: requerirSesion,
    cerrarSesion: cerrarSesion,
    llamar: llamar
  };

})();
