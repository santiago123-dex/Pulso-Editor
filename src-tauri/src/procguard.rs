//! Gestión segura del ciclo de vida de subprocesos: evita procesos huérfanos si Pulso
//! termina de golpe y cosecha procesos desacoplados para no dejar zombis en Unix.
use std::process::{Child, Command};

/// Configura un comando antes de `spawn()` para que sus procesos hijos queden en su propio
/// grupo de procesos (`setpgid(0, 0)`), permitiendo terminar todo el árbol con `kill(-pgid)`.
///
/// Nota: no usamos `PR_SET_PDEATHSIG` porque en Linux se vincula al *hilo* que llamó a `spawn()`,
/// no al proceso padre; si el comando se lanza desde `tokio::task::spawn_blocking`, el kernel
/// enviaría `SIGTERM` al hijo (p. ej. el servidor LSP o el agente IA) apenas Tokio retire ese hilo.
pub fn configure_child(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                // Propio grupo de procesos para poder terminar el árbol completo con kill(-pgid).
                let _ = libc::setpgid(0, 0);
                Ok(())
            });
        }
    }
    #[cfg(not(unix))]
    {
        let _ = cmd;
    }
}

/// Asocia el proceso recién creado al Job Object global en Windows (`KILL_ON_JOB_CLOSE`),
/// garantizando que el kernel limpie todo el árbol si Pulso se cierra o falla.
pub fn attach_job(child: &Child) {
    #[cfg(windows)]
    {
        windows_job::assign(child);
    }
    #[cfg(not(windows))]
    {
        let _ = child;
    }
}

/// Termina un proceso y todo su árbol de descendientes.
pub fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = crate::background_command("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .status();
    }
    #[cfg(unix)]
    {
        let pgid = pid as i32;
        if pgid > 0 {
            unsafe {
                // Primero intentamos con el grupo de procesos completo (-pgid) con SIGTERM.
                let _ = libc::kill(-pgid, libc::SIGTERM);
                let _ = libc::kill(pgid, libc::SIGTERM);
            }
            // Escalado breve a SIGKILL si sigue vivo.
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(250));
                unsafe {
                    if libc::kill(-pgid, 0) == 0 {
                        let _ = libc::kill(-pgid, libc::SIGKILL);
                    }
                    if libc::kill(pgid, 0) == 0 {
                        let _ = libc::kill(pgid, libc::SIGKILL);
                    }
                }
            });
        }
    }
}

/// Cosecha un subproceso desacoplado (p. ej. navegador o explorador de archivos) en un hilo
/// dedicado para que no quede en estado `<defunct>` (zombi) en Unix.
pub fn reap_detached(mut child: Child) {
    std::thread::spawn(move || {
        let _ = child.wait();
    });
}

#[cfg(windows)]
mod windows_job {
    use std::{
        os::windows::io::AsRawHandle,
        process::Child,
        sync::OnceLock,
    };
    use windows_sys::Win32::{
        Foundation::HANDLE,
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    };

    struct JobHandle(HANDLE);
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    static JOB: OnceLock<Option<JobHandle>> = OnceLock::new();

    fn get_job() -> Option<HANDLE> {
        JOB.get_or_init(|| unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                return None;
            }
            Some(JobHandle(job))
        })
        .as_ref()
        .map(|h| h.0)
    }

    pub fn assign(child: &Child) {
        if let Some(job) = get_job() {
            unsafe {
                let _ = AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE);
            }
        }
    }
}
