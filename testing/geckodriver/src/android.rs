use crate::capabilities::AndroidOptions;
use mozdevice::{AndroidStorage, Device, Host, RemoteMetadata, UnixPathBuf};
use mozprofile::profile::Profile;
use std::fs::File;
use std::io;
use std::path::PathBuf;
use std::time;
use thiserror::Error;
use webdriver::error::{ErrorStatus, WebDriverError};
use yaml_rust::yaml::{Hash, Yaml};

// TODO: avoid port clashes across GeckoView-vehicles.
// For now, we always use target port 2829, leading to issues like bug 1533704.
const MARIONETTE_TARGET_PORT: u16 = 2829;

const CONFIG_FILE_HEADING: &str = r#"## GeckoView configuration YAML
##
## Auto-generated by geckodriver.
## See https://mozilla.github.io/geckoview/consumer/docs/automation.
"#;

pub type Result<T> = std::result::Result<T, AndroidError>;

#[derive(Debug, Error)]
pub enum AndroidError {
    #[error("Activity for package '{0}' not found")]
    ActivityNotFound(String),

    #[error(transparent)]
    Device(#[from] mozdevice::DeviceError),

    #[error(transparent)]
    IO(#[from] io::Error),

    #[error("Package '{0}' not found")]
    PackageNotFound(String),

    #[error(transparent)]
    Serde(#[from] yaml_rust::EmitError),
}

impl From<AndroidError> for WebDriverError {
    fn from(value: AndroidError) -> WebDriverError {
        WebDriverError::new(ErrorStatus::UnknownError, value.to_string())
    }
}

/// A remote Gecko instance.
///
/// Host refers to the device running `geckodriver`.  Target refers to the
/// Android device running Gecko in a GeckoView-based vehicle.
#[derive(Debug)]
pub struct AndroidProcess {
    pub device: Device,
    pub package: String,
    pub activity: String,
}

impl AndroidProcess {
    pub fn new(
        device: Device,
        package: String,
        activity: String,
    ) -> mozdevice::Result<AndroidProcess> {
        Ok(AndroidProcess {
            device,
            package,
            activity,
        })
    }
}

#[derive(Debug)]
pub struct AndroidHandler {
    pub config: UnixPathBuf,
    pub options: AndroidOptions,
    pub process: AndroidProcess,
    pub profile: UnixPathBuf,
    pub test_root: UnixPathBuf,

    // Port forwarding for Marionette: host => target
    pub marionette_host_port: u16,
    pub marionette_target_port: u16,

    pub system_access: bool,

    // Port forwarding for WebSocket connections (WebDriver BiDi and CDP)
    pub websocket_port: Option<u16>,
}

impl Drop for AndroidHandler {
    fn drop(&mut self) {
        // Try to clean up various settings
        let clear_command = format!("am clear-debug-app {}", self.process.package);
        match self
            .process
            .device
            .execute_host_shell_command(&clear_command)
        {
            Ok(_) => debug!("Disabled reading from configuration file"),
            Err(e) => error!("Failed disabling from configuration file: {}", e),
        }

        match self.process.device.remove(&self.config) {
            Ok(_) => debug!("Deleted GeckoView configuration file"),
            Err(e) => error!("Failed deleting GeckoView configuration file: {}", e),
        }

        match self.process.device.remove(&self.test_root) {
            Ok(_) => debug!("Deleted test root folder: {}", &self.test_root.display()),
            Err(e) => error!("Failed deleting test root folder: {}", e),
        }

        debug!(
            "Stop forwarding Marionette port ({} -> {})",
            &self.marionette_host_port, &self.marionette_target_port
        );
        match self
            .process
            .device
            .kill_forward_port(self.marionette_host_port)
        {
            Ok(_) => {}
            Err(e) => error!(
                "Failed to stop forwarding Marionette port ({} -> {}): {}",
                &self.marionette_host_port, &self.marionette_target_port, e
            ),
        }

        if let Some(port) = self.websocket_port {
            debug!(
                "Stop forwarding WebSocket port ({} -> {})",
                &self.marionette_host_port, &self.marionette_target_port
            );
            match self.process.device.kill_forward_port(port) {
                Ok(_) => {}
                Err(e) => error!(
                    "Failed to stop forwarding WebSocket port ({0} -> {0}): {1}",
                    &port, e
                ),
            }
        }
    }
}

impl AndroidHandler {
    pub fn new(
        options: &AndroidOptions,
        marionette_host_port: u16,
        system_access: bool,
        websocket_port: Option<u16>,
    ) -> Result<AndroidHandler> {
        // We need to push profile.pathbuf to a safe space on the device.
        // Make it per-Android package to avoid clashes and confusion.
        // This naming scheme follows GeckoView's configuration file naming scheme,
        // see bug 1533385.

        let host = Host {
            host: None,
            port: None,
            read_timeout: Some(time::Duration::from_millis(5000)),
            write_timeout: Some(time::Duration::from_millis(5000)),
        };

        let mut device = host.device_or_default(options.device_serial.as_ref(), options.storage)?;

        // Set up port forwarding for Marionette.
        debug!(
            "Start forwarding Marionette port ({} -> {})",
            marionette_host_port, MARIONETTE_TARGET_PORT
        );
        device.forward_port(marionette_host_port, MARIONETTE_TARGET_PORT)?;

        if let Some(port) = websocket_port {
            // Set up port forwarding for WebSocket connections (WebDriver BiDi, and CDP).
            debug!("Start forwarding WebSocket port ({} -> {})", port, port);
            device.forward_port(port, port)?;
        }

        let test_root = match device.storage {
            AndroidStorage::App => {
                device.run_as_package = Some(options.package.to_owned());
                let mut buf = UnixPathBuf::from("/data/data");
                buf.push(&options.package);
                buf.push("test_root");
                buf
            }
            AndroidStorage::Internal => UnixPathBuf::from("/data/local/tmp/test_root"),
            AndroidStorage::Sdcard => {
                // We need to push the profile to a location on the device that can also
                // be read and write by the application, and works for unrooted devices.
                // The only location that meets this criteria is under:
                //     $EXTERNAL_STORAGE/Android/data/%options.package%/files
                let response = device.execute_host_shell_command("echo $EXTERNAL_STORAGE")?;
                let mut buf = UnixPathBuf::from(response.trim_end_matches('\n'));
                buf.push("Android/data");
                buf.push(&options.package);
                buf.push("files/test_root");
                buf
            }
        };

        debug!(
            "Connecting: options={:?}, storage={:?}) test_root={}, run_as_package={:?}",
            options,
            device.storage,
            test_root.display(),
            device.run_as_package
        );

        let mut profile = test_root.clone();
        profile.push(format!("{}-geckodriver-profile", &options.package));

        // Check if the specified package is installed
        let response =
            device.execute_host_shell_command(&format!("pm list packages {}", &options.package))?;
        let mut packages = response
            .trim()
            .split_terminator('\n')
            .filter(|line| line.starts_with("package:"))
            .map(|line| line.rsplit(':').next().expect("Package name found"));
        if !packages.any(|x| x == options.package.as_str()) {
            return Err(AndroidError::PackageNotFound(options.package.clone()));
        }

        let config = UnixPathBuf::from(format!(
            "/data/local/tmp/{}-geckoview-config.yaml",
            &options.package
        ));

        // If activity hasn't been specified default to the main activity of the package
        let activity = match options.activity {
            Some(ref activity) => activity.clone(),
            None => {
                let response = device.execute_host_shell_command(&format!(
                    "cmd package resolve-activity --brief {}",
                    &options.package
                ))?;
                let activities = response
                    .split_terminator('\n')
                    .filter(|line| line.starts_with(&options.package))
                    .map(|line| line.rsplit('/').next().unwrap())
                    .collect::<Vec<&str>>();
                if activities.is_empty() {
                    return Err(AndroidError::ActivityNotFound(options.package.clone()));
                }

                activities[0].to_owned()
            }
        };

        let process = AndroidProcess::new(device, options.package.clone(), activity)?;

        Ok(AndroidHandler {
            config,
            process,
            profile,
            test_root,
            marionette_host_port,
            marionette_target_port: MARIONETTE_TARGET_PORT,
            options: options.clone(),
            system_access,
            websocket_port,
        })
    }

    pub fn copy_minidumps_files(&self, save_path: &str) -> Result<()> {
        let minidumps_path = self.profile.join("minidumps");

        match self.process.device.list_dir(&minidumps_path) {
            Ok(entries) => {
                for entry in entries {
                    if let RemoteMetadata::RemoteFile(_) = entry.metadata {
                        let file_path = minidumps_path.join(&entry.name);

                        let extension = file_path
                            .extension()
                            .and_then(|ext| ext.to_str())
                            .map(|ext| ext.to_lowercase())
                            .unwrap_or(String::from(""));

                        if extension == "dmp" || extension == "extra" {
                            let mut dest_path = PathBuf::from(save_path);
                            dest_path.push(&entry.name);

                            self.process
                                .device
                                .pull(&file_path, &mut File::create(dest_path.as_path())?)?;

                            debug!(
                                "Copied minidump file {:?} from the device to the local path {:?}.",
                                entry.name, save_path
                            );
                        }
                    }
                }
            }
            Err(_) => {
                warn!(
                    "Couldn't read files from minidumps folder '{}'",
                    minidumps_path.display(),
                );

                return Ok(());
            }
        }

        Ok(())
    }

    pub fn generate_config_file<I, K, V>(
        &self,
        args: Option<Vec<String>>,
        envs: I,
    ) -> Result<String>
    where
        I: IntoIterator<Item = (K, V)>,
        K: ToString,
        V: ToString,
    {
        // To configure GeckoView, we use the automation techniques documented at
        // https://mozilla.github.io/geckoview/consumer/docs/automation.

        let args = {
            let mut args_yaml = Vec::from([
                "--marionette".into(),
                "--profile".into(),
                self.profile.display().to_string(),
            ]);

            if self.system_access {
                args_yaml.push("--remote-allow-system-access".into());
            }
            args_yaml.append(&mut args.unwrap_or_default());
            args_yaml.into_iter().map(Yaml::String).collect()
        };

        let mut env = Hash::new();

        for (key, value) in envs {
            env.insert(
                Yaml::String(key.to_string()),
                Yaml::String(value.to_string()),
            );
        }

        env.insert(
            Yaml::String("MOZ_CRASHREPORTER".to_owned()),
            Yaml::String("1".to_owned()),
        );
        env.insert(
            Yaml::String("MOZ_CRASHREPORTER_NO_REPORT".to_owned()),
            Yaml::String("1".to_owned()),
        );
        env.insert(
            Yaml::String("MOZ_CRASHREPORTER_SHUTDOWN".to_owned()),
            Yaml::String("1".to_owned()),
        );

        let config_yaml = {
            let mut config = Hash::new();
            config.insert(Yaml::String("env".into()), Yaml::Hash(env));
            config.insert(Yaml::String("args".into()), Yaml::Array(args));

            let mut yaml = String::new();
            let mut emitter = yaml_rust::YamlEmitter::new(&mut yaml);
            emitter.dump(&Yaml::Hash(config))?;
            yaml
        };

        Ok([CONFIG_FILE_HEADING, &*config_yaml].concat())
    }

    pub fn prepare<I, K, V>(
        &self,
        profile: &Profile,
        args: Option<Vec<String>>,
        env: I,
    ) -> Result<()>
    where
        I: IntoIterator<Item = (K, V)>,
        K: ToString,
        V: ToString,
    {
        self.process.device.clear_app_data(&self.process.package)?;

        // These permissions, at least, are required to read profiles in /mnt/sdcard.
        for perm in &["READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE"] {
            self.process.device.execute_host_shell_command(&format!(
                "pm grant {} android.permission.{}",
                &self.process.package, perm
            ))?;
        }

        // Make sure to create the test root.
        self.process.device.create_dir(&self.test_root)?;
        self.process.device.chmod(&self.test_root, "777", true)?;

        // Replace the profile
        self.process.device.remove(&self.profile)?;
        self.process
            .device
            .push_dir(&profile.path, &self.profile, 0o777)?;

        let contents = self.generate_config_file(args, env)?;
        debug!("Content of generated GeckoView config file:\n{}", contents);
        let reader = &mut io::BufReader::new(contents.as_bytes());

        debug!(
            "Pushing GeckoView configuration file to {}",
            self.config.display()
        );
        self.process.device.push(reader, &self.config, 0o777)?;

        // Tell GeckoView to read configuration even when `android:debuggable="false"`.
        self.process.device.execute_host_shell_command(&format!(
            "am set-debug-app --persistent {}",
            self.process.package
        ))?;

        Ok(())
    }

    pub fn launch(&self) -> Result<()> {
        // TODO: Remove the usage of intent arguments once Fennec is no longer
        // supported. Packages which are using GeckoView always read the arguments
        // via the YAML configuration file.
        let mut intent_arguments = self
            .options
            .intent_arguments
            .clone()
            .unwrap_or_else(|| Vec::with_capacity(3));
        intent_arguments.push("--es".to_owned());
        intent_arguments.push("args".to_owned());
        intent_arguments.push(format!("--marionette --profile {}", self.profile.display()));

        debug!(
            "Launching {}/{}",
            self.process.package, self.process.activity
        );
        self.process
            .device
            .launch(
                &self.process.package,
                &self.process.activity,
                &intent_arguments,
            )
            .map_err(|e| {
                let message = format!(
                    "Could not launch Android {}/{}: {}",
                    self.process.package, self.process.activity, e
                );
                mozdevice::DeviceError::Adb(message)
            })?;

        Ok(())
    }

    pub fn push_as_file(&self, content: &[u8], path: &str) -> Result<String> {
        let mut dest = self.test_root.clone();
        dest.push(path);

        let buffer = &mut io::Cursor::new(content);
        self.process.device.push(buffer, &dest, 0o777)?;

        Ok(dest.display().to_string())
    }

    pub fn force_stop(&self) -> Result<()> {
        debug!(
            "Force stopping the Android package: {}",
            &self.process.package
        );
        self.process.device.force_stop(&self.process.package)?;

        Ok(())
    }
}

#[cfg(test)]
mod test {
    // To successfully run those tests the geckoview_example package needs to
    // be installed on the device or emulator. After setting up the build
    // environment (https://mzl.la/3muLv5M), the following mach commands have to
    // be executed:
    //
    //     $ ./mach build && ./mach install
    //
    // Currently the mozdevice API is not safe for multiple requests at the same
    // time. It is recommended to run each of the unit tests on its own. Also adb
    // specific tests cannot be run in CI yet. To check those locally, also run
    // the ignored tests.
    //
    // Use the following command to accomplish that:
    //
    //     $ cargo test -- --ignored --test-threads=1

    use crate::android::AndroidHandler;
    use crate::capabilities::AndroidOptions;
    use mozdevice::{AndroidStorage, AndroidStorageInput, UnixPathBuf};

    fn run_handler_storage_test(package: &str, storage: AndroidStorageInput) {
        let options = AndroidOptions::new(package.to_owned(), storage);
        let handler = AndroidHandler::new(&options, 4242, true, None).expect("has valid Android handler");

        assert_eq!(handler.options, options);
        assert_eq!(handler.marionette_host_port, 4242);
        assert_eq!(handler.process.package, package);
        assert_eq!(handler.system_access, true);
        assert_eq!(handler.websocket_port, None);

        let expected_config_path = UnixPathBuf::from(format!(
            "/data/local/tmp/{}-geckoview-config.yaml",
            &package
        ));
        assert_eq!(handler.config, expected_config_path);

        if handler.process.device.storage == AndroidStorage::App {
            assert_eq!(
                handler.process.device.run_as_package,
                Some(package.to_owned())
            );
        } else {
            assert_eq!(handler.process.device.run_as_package, None);
        }

        let test_root = match handler.process.device.storage {
            AndroidStorage::App => {
                let mut buf = UnixPathBuf::from("/data/data");
                buf.push(package);
                buf.push("test_root");
                buf
            }
            AndroidStorage::Internal => UnixPathBuf::from("/data/local/tmp/test_root"),
            AndroidStorage::Sdcard => {
                let response = handler
                    .process
                    .device
                    .execute_host_shell_command("echo $EXTERNAL_STORAGE")
                    .unwrap();

                let mut buf = UnixPathBuf::from(response.trim_end_matches('\n'));
                buf.push("Android/data/");
                buf.push(package);
                buf.push("files/test_root");
                buf
            }
        };
        assert_eq!(handler.test_root, test_root);

        let mut profile = test_root;
        profile.push(format!("{}-geckodriver-profile", &package));
        assert_eq!(handler.profile, profile);
    }

    #[test]
    #[ignore]
    fn android_handler_storage_as_app() {
        let package = "org.mozilla.geckoview_example";
        run_handler_storage_test(package, AndroidStorageInput::App);
    }

    #[test]
    #[ignore]
    fn android_handler_storage_as_auto() {
        let package = "org.mozilla.geckoview_example";
        run_handler_storage_test(package, AndroidStorageInput::Auto);
    }

    #[test]
    #[ignore]
    fn android_handler_storage_as_internal() {
        let package = "org.mozilla.geckoview_example";
        run_handler_storage_test(package, AndroidStorageInput::Internal);
    }

    #[test]
    #[ignore]
    fn android_handler_storage_as_sdcard() {
        let package = "org.mozilla.geckoview_example";
        run_handler_storage_test(package, AndroidStorageInput::Sdcard);
    }
}
