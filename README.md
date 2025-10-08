# Makepad Packaging Action

## Packaging Details

### For Desktop

Use the following tools to create an installer or package for your Makepad application.

`cargo-packager` and `robius-packaging-commands` are used under the hood to create the packages.

### For Mobile

`cargo-makepad` is used to build the mobile applications for iOS and Android platforms.

### Platform-specific considerations

Note: that due to platform restrictions, you can currently only build:

* Linux packages on a Linux OS machine
* Windows installer executables on a Windows OS machine
* macOS disk images / app bundles on a macOS machine
* iOS apps on a macOS machine.
* Android, on a machine with any OS!