use std::process::{Child, Command};

use crate::error::AppError;

/// Windows：隐藏子进程控制台黑框（node.exe 等 console 子系统）。
/// 非 Windows 平台为 no-op，不影响 stdin/stdout/stderr 管道。
pub fn hide_console_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /// CREATE_NO_WINDOW — 不创建控制台窗口
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// Sidecar 启动前统一配置：隐藏黑框 + Unix 独立进程组（供 killpg 级联回收）。
pub fn prepare_sidecar_command(command: &mut Command) {
    hide_console_window(command);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // 子进程成为新进程组组长，kill_process_tree 可用 killpg 清整组
        command.process_group(0);
    }
}

/// 将已 spawn 的子进程登记到「主进程消亡即级联回收」生命周期中。
/// Windows：AssignProcessToJobObject(KILL_ON_JOB_CLOSE)；Unix：进程组已在 prepare 时设置。
pub fn register_child_for_lifecycle(child: &Child) -> Result<(), AppError> {
    #[cfg(windows)]
    {
        assign_to_kill_on_close_job(child)
    }
    #[cfg(not(windows))]
    {
        let _ = child;
        Ok(())
    }
}

/// 强制结束进程及其子进程（Windows: taskkill /T；Unix: killpg SIGTERM→SIGKILL）。
pub fn kill_process_tree(pid: u32) -> Result<(), AppError> {
    if pid == 0 {
        return Ok(());
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let status = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|error| AppError::Launcher(format!("taskkill failed: {error}")))?;

        match status.code() {
            Some(0) | Some(128) | Some(255) => Ok(()),
            Some(code) => Err(AppError::Launcher(format!(
                "taskkill exited with code {code} for pid {pid}"
            ))),
            None => Ok(()),
        }
    }

    #[cfg(unix)]
    {
        kill_unix_process_group(pid)
    }

    #[cfg(all(not(windows), not(unix)))]
    {
        Err(AppError::Launcher(format!(
            "kill_process_tree unsupported on this platform for pid {pid}"
        )))
    }
}

#[cfg(unix)]
fn kill_unix_process_group(pid: u32) -> Result<(), AppError> {
    use std::time::Duration;

    let pgid = pid as i32;
    // 先 SIGTERM 整组，短暂等待后 SIGKILL 兜底
    let term_rc = unsafe { libc::killpg(pgid, libc::SIGTERM) };
    if term_rc != 0 {
        let errno = std::io::Error::last_os_error();
        // ESRCH：进程组已不存在，视为成功
        if errno.raw_os_error() != Some(libc::ESRCH) {
            // 回退：至少杀组长
            let _ = unsafe { libc::kill(pgid, libc::SIGTERM) };
        }
    }

    std::thread::sleep(Duration::from_millis(500));

    let still_alive = unsafe { libc::killpg(pgid, 0) } == 0;
    if still_alive {
        let kill_rc = unsafe { libc::killpg(pgid, libc::SIGKILL) };
        if kill_rc != 0 {
            let errno = std::io::Error::last_os_error();
            if errno.raw_os_error() != Some(libc::ESRCH) {
                let _ = unsafe { libc::kill(pgid, libc::SIGKILL) };
            }
        }
    }

    Ok(())
}

#[cfg(windows)]
mod job_object {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::sync::OnceLock;

    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    use crate::error::AppError;

    /// 进程级 Job 句柄（保持打开；主进程退出时内核关闭 → 级联杀光 Job 内进程树）。
    static APP_JOB_HANDLE: OnceLock<isize> = OnceLock::new();

    fn ensure_app_job() -> Result<HANDLE, AppError> {
        if let Some(raw) = APP_JOB_HANDLE.get() {
            return Ok(HANDLE(*raw as *mut std::ffi::c_void));
        }

        unsafe {
            let job = CreateJobObjectW(None, windows::core::PCWSTR::null()).map_err(|error| {
                AppError::Launcher(format!("CreateJobObjectW failed: {error}"))
            })?;

            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of_val(&info) as u32,
            )
            .map_err(|error| {
                AppError::Launcher(format!("SetInformationJobObject failed: {error}"))
            })?;

            let raw = job.0 as isize;
            // 若竞态下已有其它线程先写入，丢弃本线程新建的句柄，改用已登记句柄
            if APP_JOB_HANDLE.set(raw).is_err() {
                let _ = windows::Win32::Foundation::CloseHandle(job);
                if let Some(existing) = APP_JOB_HANDLE.get() {
                    return Ok(HANDLE(*existing as *mut std::ffi::c_void));
                }
            }

            Ok(HANDLE(raw as *mut std::ffi::c_void))
        }
    }

    pub fn assign_to_kill_on_close_job(child: &Child) -> Result<(), AppError> {
        let job = ensure_app_job()?;
        let process = HANDLE(child.as_raw_handle() as *mut std::ffi::c_void);
        unsafe {
            AssignProcessToJobObject(job, process).map_err(|error| {
                AppError::Launcher(format!(
                    "AssignProcessToJobObject failed (pid={}): {error}",
                    child.id()
                ))
            })?;
        }
        Ok(())
    }
}

#[cfg(windows)]
use job_object::assign_to_kill_on_close_job;
