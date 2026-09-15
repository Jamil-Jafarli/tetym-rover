//
//  Bridging header for the WebScanner target.
//
//  Swift files in a React Native app need the RN Objective-C headers visible.
//  `react-native init` does not create this file, because it only appears the
//  moment you add the first Swift file through Xcode — scripts/add_native_files.rb
//  creates it and points SWIFT_OBJC_BRIDGING_HEADER at it.
//
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <React/RCTViewManager.h>
#import <React/RCTUtils.h>
