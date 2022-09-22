import {
  aws_route53 as route53,
  aws_route53_targets as route53_targets,
  aws_certificatemanager as acm,
  aws_ec2 as ec2,
  aws_elasticloadbalancingv2 as elbv2,
  aws_elasticloadbalancingv2_targets as elbv2_targets,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as fs from "fs";
import * as path from "path";

export class WebStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const zoneName = "acm-test.non-97.net";

    // Public Hosted Zone
    const publicHostedZone = new route53.PublicHostedZone(
      this,
      "Public Hosted Zone",
      {
        zoneName,
      }
    );

    // Certificate
    const certificate = new acm.Certificate(this, "Certificate", {
      domainName: zoneName,
      validation: acm.CertificateValidation.fromDns(publicHostedZone),
    });

    //  VPC
    const vpc = new ec2.Vpc(this, "VPC", {
      cidr: "10.0.0.0/24",
      enableDnsHostnames: true,
      enableDnsSupport: true,
      maxAzs: 1,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 27,
        },
        {
          name: "Isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 27,
        },
      ],
    });

    // S3 Gateway Endpoint
    vpc.addGatewayEndpoint("S3 Gateway Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // Security Group
    const webSg = new ec2.SecurityGroup(this, "Web SG", {
      allowAllOutbound: true,
      vpc,
    });
    webSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80));

    // User data for Nginx
    const userDataParameter = fs.readFileSync(
      path.join(__dirname, "../src/ec2/user_data_setting_nginx.sh"),
      "utf8"
    );
    const userDataSettingNginx = ec2.UserData.forLinux({
      shebang: "#!/bin/bash",
    });
    userDataSettingNginx.addCommands(userDataParameter);

    // Web EC2 Instance
    const webEC2Instance = new ec2.Instance(this, "Web EC2 Instance", {
      machineImage: ec2.MachineImage.latestAmazonLinux({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      instanceType: new ec2.InstanceType("t3.micro"),
      vpc,
      vpcSubnets: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      }),
      securityGroup: webSg,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(8, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
      propagateTagsToVolumeOnCreation: true,
      userData: userDataSettingNginx,
    });

    // NLB
    const nlb = new elbv2.NetworkLoadBalancer(this, "NLB", {
      vpc,
      crossZoneEnabled: true,
      internetFacing: true,
    });

    const listener = nlb.addListener("listener", {
      port: 443,
      alpnPolicy: elbv2.AlpnPolicy.NONE,
      certificates: [certificate],
      protocol: elbv2.Protocol.TLS,
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
    });

    listener.addTargets("Targets", {
      targets: [new elbv2_targets.InstanceTarget(webEC2Instance, 80)],
      protocol: elbv2.Protocol.TCP,
      port: 80,
    });

    // NLB Alias
    new route53.ARecord(this, "NLB Alias Record", {
      zone: publicHostedZone,
      target: route53.RecordTarget.fromAlias(
        new route53_targets.LoadBalancerTarget(nlb)
      ),
    });
  }
}
