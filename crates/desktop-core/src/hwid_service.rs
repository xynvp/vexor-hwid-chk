use serde::Serialize;
use sha2::{Digest, Sha256};
use windows_sys::Win32::{
    Storage::FileSystem::GetVolumeInformationW, System::WindowsProgramming::GetComputerNameW,
};
use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};

#[derive(Serialize)]
pub struct Identity {
    pub machine_guid: String,
    pub volume_serial: String,
    pub computer_name: String,
    pub windows_install_date: u32,
    pub windows_product: String,
    pub windows_version: String,
    pub windows_build: String,
    pub checker_version: String,
}
pub fn calculate_hwid(machine_guid: &str, volume_serial: &str, computer_name: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(machine_guid.as_bytes());
    hash.update(volume_serial.as_bytes());
    hash.update(computer_name.as_bytes());
    format!("{:x}", hash.finalize())
}
pub fn preview(hwid: &str) -> String {
    format!("{}…{}", &hwid[..14], &hwid[hwid.len() - 6..])
}
pub fn collect() -> Result<Identity, String> {
    let registry = RegKey::predef(HKEY_LOCAL_MACHINE);
    let crypto = registry
        .open_subkey(r"SOFTWARE\Microsoft\Cryptography")
        .map_err(|_| "Unable to read Windows machine identity.")?;
    let machine_guid: String = crypto
        .get_value("MachineGuid")
        .map_err(|_| "Unable to read Windows machine identity.")?;
    let root: Vec<u16> = "C:\\\0".encode_utf16().collect();
    let mut serial = 0u32;
    let success = unsafe {
        GetVolumeInformationW(
            root.as_ptr(),
            std::ptr::null_mut(),
            0,
            &mut serial,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
        )
    };
    if success == 0 {
        return Err("Unable to read the C: volume identity.".into());
    }
    let mut name = [0u16; 256];
    let mut length = name.len() as u32;
    if unsafe { GetComputerNameW(name.as_mut_ptr(), &mut length) } == 0 {
        return Err("Unable to read the computer name.".into());
    }
    let computer_name =
        String::from_utf16(&name[..length as usize]).map_err(|_| "Invalid computer name.")?;
    let windows = registry
        .open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
        .map_err(|_| "Unable to read Windows information.")?;
    let install: u32 = windows
        .get_value("InstallDate")
        .map_err(|_| "Unable to read Windows install date.")?;
    let product: String = windows
        .get_value("ProductName")
        .map_err(|_| "Unable to read Windows product.")?;
    let version: String = windows
        .get_value("DisplayVersion")
        .or_else(|_| windows.get_value("ReleaseId"))
        .unwrap_or_else(|_| "Unknown".into());
    let build: String = windows
        .get_value("CurrentBuildNumber")
        .map_err(|_| "Unable to read Windows build.")?;
    let ubr: u32 = windows.get_value("UBR").unwrap_or(0);
    // Some Windows 11 installations retain a Windows 10 ProductName in the registry.
    let product = if build.parse::<u32>().unwrap_or(0) >= 22000 {
        product.replace("Windows 10", "Windows 11")
    } else {
        product
    };
    Ok(Identity {
        machine_guid,
        volume_serial: serial.to_string(),
        computer_name,
        windows_install_date: install,
        windows_product: product,
        windows_version: version,
        windows_build: format!("{build}.{ubr}"),
        checker_version: env!("CARGO_PKG_VERSION").into(),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_vexor_vector() {
        let hwid = calculate_hwid("fcbd67b7-ae2a-4ddb-9a39-b30c3ace98bb", "2354351557", "XYZ");
        assert_eq!(
            hwid,
            "3f0b27d50a814b411912e3428d9b5f48315352ffdf04cc8349cd571f1a52e873"
        );
        assert_eq!(preview(&hwid), "3f0b27d50a814b…52e873");
    }
    #[test]
    fn windows_identity_can_be_read() {
        let identity = collect().expect("native Windows identity collection must work");
        let hwid = calculate_hwid(
            &identity.machine_guid,
            &identity.volume_serial,
            &identity.computer_name,
        );
        assert_eq!(hwid.len(), 64);
        assert!(hwid
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        assert!(identity.windows_install_date > 0);
    }
    #[test]
    fn no_case_normalization_or_separators() {
        assert_ne!(
            calculate_hwid("a", "1", "PC"),
            calculate_hwid("a", "1", "pc")
        );
        assert_eq!(
            calculate_hwid("ab", "12", "PC"),
            format!("{:x}", Sha256::digest(b"ab12PC"))
        );
    }
}
