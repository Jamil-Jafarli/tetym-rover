#!/usr/bin/env ruby
# frozen_string_literal: true

# Adds the ARScanner Swift/ObjC sources to a React Native Xcode project.
#
# `react-native init` produces a pure Objective-C project. Dropping Swift into
# it needs three things that no amount of file copying provides on its own:
#
#   1. the files registered as members of the app target's compile phase,
#   2. a bridging header, and SWIFT_OBJC_BRIDGING_HEADER pointing at it,
#   3. a Swift version on the target.
#
# Doing this by hand in Xcode works too (drag the folder in, tick the target,
# accept the bridging-header prompt) — this script is the repeatable version.
#
# Usage: ruby add_native_files.rb <path-to-ios-dir> <source-dir> [tests-dir]

require 'xcodeproj'
require 'fileutils'

ios_dir    = ARGV[0] or abort('usage: add_native_files.rb <ios-dir> <source-dir> [tests-dir]')
source_dir = ARGV[1] or abort('usage: add_native_files.rb <ios-dir> <source-dir> [tests-dir]')
tests_dir  = ARGV[2]

project_path = Dir.glob(File.join(ios_dir, '*.xcodeproj')).first
abort("No .xcodeproj found in #{ios_dir}") unless project_path

project = Xcodeproj::Project.open(project_path)
app_name = File.basename(project_path, '.xcodeproj')

app_target = project.targets.find { |t| t.name == app_name } ||
             project.targets.find { |t| t.product_type == 'com.apple.product-type.application' }
abort('Could not find the application target') unless app_target

puts "→ project: #{File.basename(project_path)}   target: #{app_target.name}"

# --- 1. copy sources into ios/<App>/ARScanner ------------------------------
dest_dir = File.join(ios_dir, app_name, 'ARScanner')
FileUtils.mkdir_p(dest_dir)
FileUtils.cp(Dir.glob(File.join(source_dir, '*.{swift,m,h}')), dest_dir)

bridging_name = "#{app_name}-Bridging-Header.h"
generic_header = File.join(dest_dir, 'WebScanner-Bridging-Header.h')
bridging_path = File.join(dest_dir, bridging_name)
FileUtils.mv(generic_header, bridging_path) if File.exist?(generic_header) && generic_header != bridging_path

# --- 2. register them with the target --------------------------------------
group = project.main_group.find_subpath("#{app_name}/ARScanner", true)
group.set_source_tree('SOURCE_ROOT')
group.set_path("#{app_name}/ARScanner")

# Start clean so re-running the script does not create duplicate build files.
group.files.dup.each do |f|
  app_target.source_build_phase.files.each do |bf|
    bf.remove_from_project if bf.file_ref == f
  end
  f.remove_from_project
end

added = []
Dir.glob(File.join(dest_dir, '*.{swift,m}')).sort.each do |path|
  ref = group.new_reference(File.basename(path))
  app_target.add_file_references([ref])
  added << File.basename(path)
end
group.new_reference(bridging_name) if File.exist?(bridging_path)
puts "→ compiled: #{added.join(', ')}"

# --- 3. build settings ------------------------------------------------------
app_target.build_configurations.each do |config|
  s = config.build_settings
  s['SWIFT_OBJC_BRIDGING_HEADER'] = "#{app_name}/ARScanner/#{bridging_name}"
  s['SWIFT_VERSION'] ||= '5.0'
  s['ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES'] = 'YES'
  s['CLANG_ENABLE_MODULES'] = 'YES'
  # ARPlaneAnchor.planeExtent is iOS 16+; RN itself wants 15.1+.
  current = s['IPHONEOS_DEPLOYMENT_TARGET'].to_f
  s['IPHONEOS_DEPLOYMENT_TARGET'] = '16.0' if current < 16.0
end

# --- 4. optional: the cross-language conformance test ----------------------
if tests_dir && Dir.exist?(tests_dir)
  test_target = project.targets.find { |t| t.test_target_type? }
  if test_target
    test_dest = File.join(ios_dir, "#{app_name}Tests")
    if Dir.exist?(test_dest)
      Dir.glob(File.join(tests_dir, '*.swift')).each do |path|
        body = File.read(path)
        # The test imports the app module, whose name is whatever the project
        # is called — rewrite the placeholder rather than forcing a name.
        body = body.gsub('@testable import WebScanner', "@testable import #{app_name}")
        out = File.join(test_dest, File.basename(path))
        File.write(out, body)

        test_group = project.main_group.find_subpath("#{app_name}Tests", true)
        existing = test_group.files.find { |f| f.display_name == File.basename(path) }
        unless existing
          ref = test_group.new_reference(File.basename(path))
          test_target.add_file_references([ref])
        end
      end
      test_target.build_configurations.each do |config|
        config.build_settings['SWIFT_VERSION'] ||= '5.0'
      end
      puts "→ tests added to #{test_target.name} (run with Cmd+U)"
    end
  else
    puts '→ no test target found; skipping the conformance test'
  end
end

project.save
puts "✓ #{File.basename(project_path)} updated"
