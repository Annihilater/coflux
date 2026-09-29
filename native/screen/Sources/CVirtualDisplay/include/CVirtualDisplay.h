// Private CoreGraphics virtual-display interfaces used by coflux-screen (plan
// 20260929-remote-desktop). The SDK does not ship these declarations; the classes exist in the
// CoreGraphics framework on macOS 26 and 27 and are resolved by the Objective-C runtime at load.
// Declared here exactly as recorded in the plan's Maintenance notes. Behind the Swift
// `VirtualDisplayProvider` adapter so the macOS 27 SkyLight `SLVirtualDisplay*` family (also
// listed there) can replace them without touching callers.
#ifndef COFLUX_CVIRTUALDISPLAY_H
#define COFLUX_CVIRTUALDISPLAY_H

#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@class CGVirtualDisplay;

@interface CGVirtualDisplayMode : NSObject
@property(readonly, nonatomic) NSUInteger width;
@property(readonly, nonatomic) NSUInteger height;
@property(readonly, nonatomic) double refreshRate;
- (instancetype)initWithWidth:(NSUInteger)width height:(NSUInteger)height refreshRate:(double)refreshRate;
@end

@interface CGVirtualDisplaySettings : NSObject
@property(nonatomic, copy) NSArray<CGVirtualDisplayMode *> *modes;
@property(nonatomic) unsigned int hiDPI;
- (instancetype)init;
@end

@interface CGVirtualDisplayDescriptor : NSObject
@property(nonatomic, strong, nullable) dispatch_queue_t queue;
@property(nonatomic, copy) NSString *name;
@property(nonatomic) unsigned int maxPixelsWide;
@property(nonatomic) unsigned int maxPixelsHigh;
@property(nonatomic) CGSize sizeInMillimeters;
@property(nonatomic) unsigned int vendorID;
@property(nonatomic) unsigned int productID;
@property(nonatomic) unsigned int serialNum;
@property(nonatomic, copy, nullable) void (^terminationHandler)(id _Nullable sender, CGVirtualDisplay *_Nullable display);
- (instancetype)init;
@end

@interface CGVirtualDisplay : NSObject
@property(readonly, nonatomic) CGDirectDisplayID displayID;
- (nullable instancetype)initWithDescriptor:(CGVirtualDisplayDescriptor *)descriptor;
- (BOOL)applySettings:(CGVirtualDisplaySettings *)settings;
@end

NS_ASSUME_NONNULL_END

#endif
